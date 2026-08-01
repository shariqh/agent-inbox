#!/usr/bin/env bash
# Install Agent Inbox for Claude Code, Copilot CLI, or both.
#
# DRY RUN IS THE DEFAULT. --apply registers the MCP server and writes one
# managed instruction block while preserving every unrelated line.
# If the target file already imports docs/reporting-snippet.md itself (Claude Code
# only), the managed block cites that import instead of inlining a second copy.
#
# Usage:
#   npm run install:agents
#   npm run install:agents -- --apply
#   npm run install:agents -- --apply --target claude
#   npm run install:agents -- --apply --target copilot
#   npm run install:agents -- --apply --force
#   npm run install:agents -- --apply --uninstall
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APPLY=0
FORCE=0
UNINSTALL=0
TARGET="all"
BEGIN='<!-- agent-inbox:begin -->'
END='<!-- agent-inbox:end -->'
SNIPPET_SOURCE="$ROOT/docs/reporting-snippet.md"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1; shift ;;
    --dry-run) APPLY=0; shift ;;
    --force) FORCE=1; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    --target)
      [ "$#" -ge 2 ] || { echo "install-agents: --target needs all, claude, or copilot" >&2; exit 2; }
      TARGET="$2"
      shift 2
      ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) echo "install-agents: unknown flag: $1 (try --help)" >&2; exit 2 ;;
  esac
done

case "$TARGET" in
  all) TARGETS=(claude copilot) ;;
  claude|copilot) TARGETS=("$TARGET") ;;
  *) echo "install-agents: --target must be all, claude, or copilot" >&2; exit 2 ;;
esac

LOCK_FILE="${AGENT_INBOX_INSTALL_LOCK_DIR:-$HOME/.agent-inbox/install-agents.lock}"
LOCK_ACQUIRED=0
acquire_install_lock() {
  mkdir -p "$(dirname "$LOCK_FILE")" || return 1
  if [ -d "$LOCK_FILE" ] || [ -L "$LOCK_FILE" ]; then
    echo "install-agents: install lock path must be a regular file: $LOCK_FILE" >&2
    return 1
  fi
  exec 9>> "$LOCK_FILE" || return 1
  if command -v lockf >/dev/null 2>&1; then
    lockf -s -t 0 9 || {
      echo "install-agents: another setup is already running" >&2
      return 1
    }
  elif command -v flock >/dev/null 2>&1; then
    flock -n 9 || {
      echo "install-agents: another setup is already running" >&2
      return 1
    }
  else
    echo "install-agents: setup requires lockf or flock for safe concurrent installation" >&2
    return 1
  fi
  LOCK_ACQUIRED=1
}

if [ "$APPLY" -eq 1 ]; then
  acquire_install_lock || exit 1
fi

stable_path() {
  [ -n "${1:-}" ] || return 0
  echo "$(cd "$(dirname "$1")" 2>/dev/null && pwd -P)/$(basename "$1")"
}

resolve_node() {
  if [ -n "${AGENT_INBOX_NODE:-}" ] && [ -x "${AGENT_INBOX_NODE}" ]; then
    stable_path "$AGENT_INBOX_NODE"
    return
  fi
  if command -v fnm >/dev/null 2>&1 && [ -r "$ROOT/.node-version" ]; then
    local found
    found="$(fnm exec --using="$(cat "$ROOT/.node-version")" -- sh -c 'command -v node' 2>/dev/null || true)"
    if [ -n "$found" ] && [ -x "$found" ]; then stable_path "$found"; return; fi
  fi
  local candidate
  for candidate in "$HOME"/.local/share/fnm/node-versions/v24.*/installation/bin/node; do
    if [ -x "$candidate" ]; then echo "$candidate"; return; fi
  done
  stable_path "$(command -v node || true)"
}

instruction_file() {
  case "$1" in
    claude) echo "$HOME/.claude/CLAUDE.md" ;;
    copilot) echo "$HOME/.copilot/copilot-instructions.md" ;;
  esac
}

instruction_write_file() {
  local file
  file="$(instruction_file "$1")"
  if [ -L "$file" ]; then
    realpath "$file" 2>/dev/null || {
      echo "install-agents: $file is a dangling symlink — refusing to replace it" >&2
      return 1
    }
  else
    echo "$file"
  fi
}

instruction_appendix() {
  case "$1" in
    claude) echo "$ROOT/docs/instructions/claude-code.md" ;;
    copilot) echo "$ROOT/docs/instructions/copilot-cli.md" ;;
  esac
}

marker_count() {
  local marker="$1" file="$2"
  [ -f "$file" ] || { echo 0; return; }
  grep -Fxc "$marker" "$file" 2>/dev/null || true
}

preflight_markers() {
  local file="$1"
  local begins ends begin_line end_line
  begins="$(marker_count "$BEGIN" "$file")"
  ends="$(marker_count "$END" "$file")"
  if [ "$begins" -eq 0 ] && [ "$ends" -eq 0 ]; then return 0; fi
  if [ "$begins" -ne 1 ] || [ "$ends" -ne 1 ]; then
    echo "install-agents: unmatched managed markers in $file — refusing to overwrite it" >&2
    return 1
  fi
  begin_line="$(grep -Fn "$BEGIN" "$file" | cut -d: -f1)"
  end_line="$(grep -Fn "$END" "$file" | cut -d: -f1)"
  if [ "$begin_line" -ge "$end_line" ]; then
    echo "install-agents: unmatched managed markers in $file — begin must precede end" >&2
    return 1
  fi
}

# Suppressing the inline asserts, in the managed block itself, that this file
# already imports docs/reporting-snippet.md. If that is false the reporting
# contract then exists NOWHERE, so the bar is high: a directive line Claude Code
# would actually resolve, reaching THIS repo's snippet. Anything short of that
# inlines — a duplicated snippet is wasteful, a missing contract is silent
# breakage.
#
# SHAPE (snippet_directives). First non-blank character `@`, with at most three
# leading spaces. Four or more spaces, or a leading tab, is a markdown indented
# code block; anything between ``` / ~~~ fences is a fenced one. Claude Code
# renders both as text and resolves nothing there — and someone documenting the
# import inside their own instructions is exactly this file's audience. Prose
# that merely names the file, and a `@…` inside a code span, start with some
# other character and never reach the token. Only the region OUTSIDE BEGIN/END
# is read, so the installer can never be fooled by its own output.
#
# TARGET (resolves_to_snippet). `~/` expands to $HOME; a relative path resolves
# against the directory of the file being scanned, which is where Claude Code
# resolves a relative import from; identity is the same-file test, so symlinks,
# `..` segments, hard links and alternate spellings all agree. A dangling path
# left behind when the checkout moved, a URL, and a different file that merely
# ends in the same name are none of them imports.
snippet_directives() {
  awk -v begin="$BEGIN" -v end="$END" '
    $0 == begin { skip = 1; next }
    $0 == end { skip = 0; next }
    skip { next }
    {
      indent = 0
      tabbed = 0
      while (indent < length($0)) {
        c = substr($0, indent + 1, 1)
        if (c == " ") { indent++; continue }
        if (c == "\t") { tabbed = 1 }
        break
      }
      if (tabbed || indent >= 4) next
      body = substr($0, indent + 1)
      head = substr(body, 1, 3)
      if (head == "```" || head == "~~~") { fenced = !fenced; next }
      if (fenced) next
      if (substr(body, 1, 1) != "@") next
      token = substr(body, 2)
      cut = index(token, " ")
      tab = index(token, "\t")
      if (tab > 0 && (cut == 0 || tab < cut)) cut = tab
      if (cut > 0) token = substr(token, 1, cut - 1)
      if (token != "") print token
    }
  ' "$1"
}

resolves_to_snippet() {
  local token="$1" base="$2" candidate
  case "$token" in
    '~/'*) candidate="$HOME/${token#\~/}" ;;
    /*) candidate="$token" ;;
    *) candidate="$base/$token" ;;
  esac
  [ -f "$candidate" ] || return 1
  [ "$candidate" -ef "$SNIPPET_SOURCE" ]
}

imports_snippet() {
  local file="$1" base token
  [ -f "$file" ] || return 1
  base="$(dirname "$file")"
  while IFS= read -r token; do
    [ -n "$token" ] || continue
    resolves_to_snippet "$token" "$base" && return 0
  done <<< "$(snippet_directives "$file")"
  return 1
}

# Import awareness is a property of the HOST, not of the file. Claude Code
# resolves `@path` imports at load time, so an inlined copy beside one is both a
# duplicate (~2,300 tokens every session) and a snapshot that goes stale on the
# next snippet edit — the exact drift the human's import exists to prevent.
# Copilot CLI has no import mechanism, so an `@path` line in its instructions is
# inert text: skipping the inline there would silently delete the reporting
# contract instead of de-duplicating it. Inlining is correct for Copilot, always.
host_resolves_imports() {
  [ "$1" = claude ]
}

snippet_import_note() {
  cat <<'NOTE'
## Agent Inbox — reporting instructions

Not inlined here: this file already imports `docs/reporting-snippet.md` itself, so the
shared reporting contract stays live from that file. A copy in this block would be a
snapshot that goes stale the next time the snippet changes.
NOTE
}

build_block() {
  local target="$1" output="$2" omit_snippet="$3"
  {
    echo "$BEGIN" || return 1
    if [ "$omit_snippet" -eq 1 ]; then
      snippet_import_note || return 1
    else
      sed '1s/^# /## /' "$SNIPPET_SOURCE" || return 1
    fi
    echo || return 1
    cat "$(instruction_appendix "$target")" || return 1
    echo "$END" || return 1
  } > "$output"
}

render_file() {
  local file="$1" block="$2" output="$3" remove="$4"
  local begins
  begins="$(marker_count "$BEGIN" "$file")"
  if [ "$begins" -eq 1 ]; then
    awk -v begin="$BEGIN" -v end="$END" -v block="$block" -v remove="$remove" '
      $0 == begin {
        if (remove != "1") {
          while ((read = getline line < block) > 0) print line
          if (read < 0) exit 2
        }
        skip = 1
        next
      }
      $0 == end { skip = 0; next }
      !skip { print }
    ' "$file" > "$output" || return 1
    return 0
  fi
  if [ "$remove" -eq 1 ]; then
    if [ -f "$file" ]; then cp "$file" "$output" || return 1; else : > "$output" || return 1; fi
    return
  fi
  if [ -f "$file" ]; then
    local last
    cat "$file" > "$output" || return 1
    last="$(tail -c 1 "$file")" || return 1
    if [ -s "$file" ] && [ -n "$last" ]; then echo >> "$output" || return 1; fi
  else
    : > "$output" || return 1
  fi
  cat "$block" >> "$output" || return 1
}

print_command() {
  printf '  '
  printf '%q ' "$@"
  printf '\n'
}

mcp_commands() {
  local target="$1" operation="$2"
  case "$target:$operation" in
    claude:get) MCP_CMD=(claude mcp get agent-inbox) ;;
    claude:add) MCP_CMD=(claude mcp add --scope user agent-inbox -- "$NODE" "$ENTRY") ;;
    claude:remove) MCP_CMD=(claude mcp remove --scope user agent-inbox) ;;
    copilot:get) MCP_CMD=(copilot mcp get agent-inbox --json) ;;
    copilot:add) MCP_CMD=(copilot mcp add agent-inbox -- "$NODE" "$ENTRY") ;;
    copilot:remove) MCP_CMD=(copilot mcp remove agent-inbox) ;;
  esac
}

has_user_registration() {
  local target="$1" output
  mcp_commands "$target" get
  output="$("${MCP_CMD[@]}" 2>/dev/null)" || return 1
  case "$target" in
    claude) printf '%s\n' "$output" | grep -Fq 'Scope: User config' ;;
    copilot) printf '%s\n' "$output" | grep -Eq '"source"[[:space:]]*:[[:space:]]*"user"' ;;
  esac
}

registration_config_file() {
  case "$1" in
    claude) echo "$HOME/.claude.json" ;;
    copilot) echo "$HOME/.copilot/mcp-config.json" ;;
  esac
}

user_registration_state() {
  local target="$1" config code
  if has_user_registration "$target"; then
    echo present
    return 0
  fi
  config="$(registration_config_file "$target")"
  if [ ! -e "$config" ] && [ ! -L "$config" ]; then
    echo absent
    return 0
  fi
  [ -n "$JSON_NODE" ] || return 1
  "$JSON_NODE" -e '
    const fs = require("node:fs")
    const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    process.exit(parsed.mcpServers && parsed.mcpServers["agent-inbox"] ? 10 : 0)
  ' "$config" >/dev/null 2>&1
  code=$?
  case "$code" in
    0) echo absent ;;
    10) echo present ;;
    *) return 1 ;;
  esac
}

NEWLY_ADDED=""
NEEDS_RESTORE=""
capture_registration_config() {
  local target="$1" config
  config="$(registration_config_file "$target")"
  if [ -z "$JSON_NODE" ] || [ ! -f "$config" ]; then
    echo "install-agents: cannot safely snapshot the $target user MCP configuration at $config" >&2
    return 1
  fi
  if ! "$JSON_NODE" -e '
    const fs = require("node:fs")
    const parsed = JSON.parse(fs.readFileSync(process.argv[1], "utf8"))
    if (!parsed.mcpServers || !parsed.mcpServers["agent-inbox"]) process.exit(1)
  ' "$config" >/dev/null 2>&1; then
    echo "install-agents: $config does not contain a readable agent-inbox registration" >&2
    return 1
  fi
  cp -p "$config" "$WORK/$target.mcp-config" || {
    echo "install-agents: could not snapshot $config" >&2
    return 1
  }
  printf '%s\n' "$config" > "$WORK/$target.mcp-config-path"
}

restore_registration_config() {
  local target="$1" config destination restore
  config="$(< "$WORK/$target.mcp-config-path")"
  if [ -L "$config" ]; then
    destination="$(realpath "$config" 2>/dev/null)" || return 1
  else
    destination="$config"
  fi
  restore="$(mktemp "$(dirname "$destination")/.agent-inbox-mcp.XXXXXX")" || return 1
  if cp -p "$WORK/$target.mcp-config" "$restore" && mv "$restore" "$destination"; then return 0; fi
  rm -f "$restore"
  return 1
}

rollback_mcp_changes() {
  local target
  for target in $NEWLY_ADDED; do
    mcp_commands "$target" remove
    if "${MCP_CMD[@]}" >/dev/null 2>&1; then
      echo "$target: rolled back MCP registration from failed install" >&2
    else
      echo "install-agents: warning: could not roll back $target MCP registration" >&2
    fi
  done
  for target in $NEEDS_RESTORE; do
    if restore_registration_config "$target"; then
      echo "$target: restored exact MCP configuration after failed install" >&2
    else
      : > "$WORK/$target.preserve-mcp-snapshot"
      echo "install-agents: warning: could not restore $target MCP registration; recovery snapshot retained at $WORK/$target.mcp-config" >&2
    fi
  done
}

ENTRY="${AGENT_INBOX_MCP_ENTRY:-$ROOT/dist/mcp-server.js}"
SELFTEST="${AGENT_INBOX_SELFTEST_ENTRY:-$ROOT/dist/hook-cli.js}"
JSON_NODE="$(resolve_node)"
NODE=""
if [ "$UNINSTALL" -eq 0 ]; then
  NODE="$JSON_NODE"
  [ -n "$NODE" ] || { echo "install-agents: no Node binary found — set AGENT_INBOX_NODE" >&2; exit 1; }
  NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)"
  [ "$NODE_MAJOR" = 24 ] || { echo "install-agents: Node 24 is required; resolved '$NODE' reports major ${NODE_MAJOR:-unknown}" >&2; exit 1; }
  [ -f "$ENTRY" ] || { echo "install-agents: $ENTRY is missing — run 'npm run build' first" >&2; exit 1; }
  [ -f "$SELFTEST" ] || { echo "install-agents: $SELFTEST is missing — run 'npm run build' first" >&2; exit 1; }
  if [ "$APPLY" -eq 1 ] && ! "$NODE" "$SELFTEST" selftest >/dev/null 2>&1; then
    echo "install-agents: Node selftest failed; use Node 24 or set AGENT_INBOX_NODE" >&2
    exit 1
  fi
fi

for target in "${TARGETS[@]}"; do
  file="$(instruction_write_file "$target")" || exit 1
  preflight_markers "$file" || exit 1
  if [ "$APPLY" -eq 1 ] && [ "$UNINSTALL" -eq 0 ] && ! command -v "$target" >/dev/null 2>&1; then
    echo "install-agents: '$target' CLI is not installed; choose a different --target" >&2
    exit 1
  fi
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/agent-inbox-install.XXXXXX")" || exit 1
cleanup() {
  local target temp_path
  for target in claude copilot; do
    if [ -f "$WORK/$target.temp-path" ]; then
      temp_path="$(< "$WORK/$target.temp-path")"
      rm -f "$temp_path"
    fi
    rm -f "$WORK/$target.block" "$WORK/$target.rendered" "$WORK/$target.original" \
      "$WORK/$target.temp-path" "$WORK/$target.existed" "$WORK/$target.skip" "$WORK/$target.applied"
    if [ ! -f "$WORK/$target.preserve-mcp-snapshot" ]; then
      rm -f "$WORK/$target.mcp-config" "$WORK/$target.mcp-config-path"
    fi
    rm -f "$WORK/$target.preserve-mcp-snapshot"
  done
  rmdir "$WORK" 2>/dev/null || true
}

rollback_files() {
  local target file rollback
  for target in "${TARGETS[@]}"; do
    [ -f "$WORK/$target.applied" ] || continue
    file="$(instruction_write_file "$target")" || continue
    if [ -f "$WORK/$target.existed" ]; then
      rollback="$file.rollback.$$"
      if cp -p "$WORK/$target.original" "$rollback" && mv "$rollback" "$file"; then
        echo "$target: restored instructions after failed install" >&2
      else
        rm -f "$rollback"
        echo "install-agents: warning: could not restore $file" >&2
      fi
    elif rm -f "$file"; then
      echo "$target: removed partial instruction file after failed install" >&2
    else
      echo "install-agents: warning: could not remove partial $file" >&2
    fi
  done
}

TRANSACTION_ACTIVE=0
interrupt_install() {
  trap - INT TERM
  if [ "$TRANSACTION_ACTIVE" -eq 1 ]; then
    TRANSACTION_ACTIVE=0
    echo "install-agents: interrupted — restoring prior configuration" >&2
    rollback_files
    rollback_mcp_changes
  fi
  exit 130
}
trap cleanup EXIT
trap interrupt_install INT TERM

if [ "$APPLY" -eq 0 ]; then
  echo "── dry run: nothing was written or registered. Re-run with --apply. ──" >&2
fi

for target in "${TARGETS[@]}"; do
  display_file="$(instruction_file "$target")"
  file="$(instruction_write_file "$target")" || exit 1
  block="$WORK/$target.block"
  rendered="$WORK/$target.rendered"
  omit_snippet=0
  if [ "$UNINSTALL" -eq 0 ] && host_resolves_imports "$target" && imports_snippet "$file"; then
    omit_snippet=1
    echo "$target: $display_file already imports docs/reporting-snippet.md — skipping the inlined snippet; the managed block carries the $target appendix only" >&2
  fi
  if ! build_block "$target" "$block" "$omit_snippet"; then
    echo "install-agents: could not build the $target instruction block" >&2
    exit 1
  fi
  if ! render_file "$file" "$block" "$rendered" "$UNINSTALL"; then
    echo "install-agents: could not render $display_file" >&2
    exit 1
  fi

  if [ "$APPLY" -eq 0 ]; then
    echo "── $target MCP command ──"
    if [ "$UNINSTALL" -eq 1 ]; then
      mcp_commands "$target" remove
    else
      mcp_commands "$target" add
    fi
    print_command "${MCP_CMD[@]}"
    echo "── $display_file ──"
    cat "$rendered" || {
      echo "install-agents: could not display rendered instructions for $display_file" >&2
      exit 1
    }
  fi
done

if [ "$APPLY" -eq 0 ]; then exit 0; fi

for target in "${TARGETS[@]}"; do
  file="$(instruction_write_file "$target")" || exit 1
  rendered="$WORK/$target.rendered"
  if cmp -s "$file" "$rendered" 2>/dev/null; then
    : > "$WORK/$target.skip"
    continue
  fi

  dir="$(dirname "$file")"
  if ! mkdir -p "$dir"; then
    echo "install-agents: could not create $dir" >&2
    exit 1
  fi
  temp="$(mktemp "$dir/.agent-inbox.$target.XXXXXX")" || {
    echo "install-agents: could not stage $file" >&2
    exit 1
  }
  printf '%s\n' "$temp" > "$WORK/$target.temp-path"

  if [ -f "$file" ]; then
    cp -p "$file" "$WORK/$target.original" || {
      echo "install-agents: could not preserve $file" >&2
      exit 1
    }
    : > "$WORK/$target.existed"
    cp -p "$file" "$temp" || {
      echo "install-agents: could not stage $file" >&2
      exit 1
    }
    if ! cat "$rendered" > "$temp"; then
      echo "install-agents: could not write staged instructions for $file" >&2
      exit 1
    fi
  elif ! cp "$rendered" "$temp"; then
    echo "install-agents: could not stage $file" >&2
    exit 1
  fi
done

TRANSACTION_ACTIVE=1
for target in "${TARGETS[@]}"; do
  if ! command -v "$target" >/dev/null 2>&1; then
    echo "$target: CLI is unavailable; removing the managed instruction block only" >&2
    continue
  fi

  registration_state="$(user_registration_state "$target")" || {
    rollback_mcp_changes
    echo "install-agents: could not determine whether $target has a user-scoped agent-inbox registration; refusing to change it" >&2
    exit 1
  }
  had_user=0
  if [ "$registration_state" = present ]; then
    had_user=1
    if [ "$UNINSTALL" -eq 1 ] || [ "$FORCE" -eq 1 ]; then
      if ! capture_registration_config "$target"; then
        rollback_mcp_changes
        echo "install-agents: existing MCP registrations and instructions were not changed" >&2
        exit 1
      fi
      NEEDS_RESTORE="$NEEDS_RESTORE $target"
      mcp_commands "$target" remove
      if ! "${MCP_CMD[@]}" >/dev/null; then
        rollback_mcp_changes
        echo "install-agents: could not remove the $target user-scoped MCP registration; instructions were not changed" >&2
        exit 1
      fi
      echo "$target: removed existing agent-inbox MCP registration" >&2
      if [ "$UNINSTALL" -eq 1 ]; then continue; fi
    else
      echo "$target: agent-inbox MCP is already registered (use --force to replace it)" >&2
      continue
    fi
  elif [ "$UNINSTALL" -eq 1 ]; then
    echo "$target: no user-scoped agent-inbox MCP registration found" >&2
    continue
  fi

  if [ "$had_user" -eq 0 ]; then
    NEWLY_ADDED="$NEWLY_ADDED $target"
  fi
  mcp_commands "$target" add
  if ! "${MCP_CMD[@]}" >/dev/null; then
    rollback_mcp_changes
    echo "install-agents: could not register the $target user-scoped MCP; instructions were not changed" >&2
    exit 1
  fi
  echo "$target: registered agent-inbox MCP with $NODE" >&2
done

for target in "${TARGETS[@]}"; do
  [ -f "$WORK/$target.skip" ] && continue
  file="$(instruction_write_file "$target")" || {
    rollback_files
    rollback_mcp_changes
    exit 1
  }
  if [ -f "$WORK/$target.existed" ]; then
    backup="$file.bak.$(date +%Y%m%d%H%M%S).$$"
    suffix=0
    while [ -e "$backup" ]; do
      suffix=$((suffix + 1))
      backup="$file.bak.$(date +%Y%m%d%H%M%S).$$.$suffix"
    done
    if ! cp -p "$WORK/$target.original" "$backup"; then
      rollback_files
      rollback_mcp_changes
      echo "install-agents: could not back up $file" >&2
      exit 1
    fi
    echo "backed up → $backup" >&2
  fi

  temp="$(< "$WORK/$target.temp-path")"
  : > "$WORK/$target.applied"
  if ! mv "$temp" "$file"; then
    rollback_files
    rollback_mcp_changes
    echo "install-agents: could not replace $file" >&2
    exit 1
  fi
done

TRANSACTION_ACTIVE=0
echo "Start a fresh agent session to load MCP and instruction changes." >&2
