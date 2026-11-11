#!/usr/bin/env bash
# Workspace sweep helper (#248): the inventory and checks of
# docs/workspace-hygiene.md, automated.
#
# DRY RUN IS THE DEFAULT and is strictly read-only: no `git fetch`, no
# `git worktree prune`, no write of any kind. It prints one tab-separated line
# per candidate and a summary:
#
#   kind  path-or-ref  size  last-change  pr-state  checks  action
#
# kind is worktree, branch, remote, build or temp; checks names the safety
# checks the item passed ((a) reachable from origin/main, (b) inside a merged
# or closed PR head, (c) `git cherry` only "-", (d) on a remote branch); action
# is `remove` or `keep: <reason>`. Lines starting with "#" are notes.
#
# Usage:
#   npm run sweep                          # dry run
#   npm run sweep -- --fetch               # `git fetch --prune origin` first
#   npm run sweep -- --apply               # fetch, then remove the `remove` candidates
#   bash scripts/workspace-sweep.sh [--apply] [--fetch] [--main DIR]
#        [--worktrees DIR] [--repo OWNER/NAME] [--runtime-root DIR]
#
# --apply implies --fetch: check (d) trusts remote-tracking refs, and a stale
# one (a branch since deleted or force-pushed on origin) must never vouch for a
# deletion. A failed fetch exits 2 with nothing removed. It then re-verifies
# every candidate immediately before deleting it, one at a time:
# `git worktree remove` (never --force, never rm -rf), `git branch -D`,
# `git push --force-with-lease=<ref>:<listed tip> origin --delete` only while
# `git ls-remote` still shows the listed tip, and `rm -rf --` by absolute path
# for temp entries under $TMPDIR.
#
# Never touches: main, the main checkout's current branch, a branch checked
# out in a kept worktree, open-PR heads and bases, anything changed in the last
# 2 hours, ~/.agent-inbox, ~/.claude*, ~/.copilot*, other repositories, and the
# main checkout's working tree (dist/, node_modules/, tracked and untracked
# files). Runtimes are reported, never removed (install-agents.sh prunes them).
#
# Exit: 0 success, 2 failed closed (gh unavailable or failing: nothing is
# removed; also a failed fetch under --fetch or --apply), 64 usage error.
set -u
set -f  # no pathname expansion anywhere: names and prefixes are data

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
TAB="$(printf '\t')"
NL='
'
RECENT_MIN=120
RECENT_S=$((RECENT_MIN * 60))
DEFAULT_BRANCH=main
GH_LIMIT=4000

APPLY=0
FETCH=0
MAIN=""
WT=""
REPO_SLUG=""
RUNTIME_ROOT=""

usage() { awk 'NR > 1 && !/^#/ { exit } NR > 1' "${BASH_SOURCE[0]}" | sed 's/^# \{0,1\}//'; }
usage_error() { echo "workspace-sweep: $1 (try --help)" >&2; exit 64; }

while [ $# -gt 0 ]; do
  case "$1" in
    --apply) APPLY=1 ;;
    --dry-run) APPLY=0 ;;
    --fetch) FETCH=1 ;;
    --main|--worktrees|--repo|--runtime-root)
      [ $# -ge 2 ] && [ -n "$2" ] || usage_error "$1 needs a value"
      case "$1" in
        --main) MAIN="$2" ;;
        --worktrees) WT="$2" ;;
        --repo) REPO_SLUG="$2" ;;
        --runtime-root) RUNTIME_ROOT="$2" ;;
      esac
      shift ;;
    -h|--help) usage; exit 0 ;;
    *) usage_error "unknown argument: $1" ;;
  esac
  shift
done

# Read-only in every git command: no index refresh writes from `git status`.
export GIT_OPTIONAL_LOCKS=0
export GIT_TERMINAL_PROMPT=0
[ -n "${HOME:-}" ] || usage_error "HOME is not set"

if [ -z "$MAIN" ]; then
  common="$(git -C "$REPO_DIR" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" ||
    usage_error "cannot find the main checkout; pass --main"
  MAIN="$(dirname "$common")"
fi
[ -d "$MAIN" ] || usage_error "--main is not a directory: $MAIN"
MAIN="$(cd "$MAIN" && pwd -P)"
[ "$(git -C "$MAIN" rev-parse --show-toplevel 2>/dev/null)" = "$MAIN" ] ||
  usage_error "--main is not the top of a git checkout: $MAIN"
MAIN_COMMON="$(git -C "$MAIN" rev-parse --path-format=absolute --git-common-dir)"
[ "$MAIN_COMMON" = "$MAIN/.git" ] || usage_error "--main is a linked worktree, not the main checkout: $MAIN"
[ -n "$WT" ] || WT="$HOME/Development/copilot-worktrees/agent-inbox"
if [ -d "$WT" ]; then WT="$(cd "$WT" && pwd -P)"; fi
[ "$WT" != "$MAIN" ] || usage_error "--worktrees must not be the main checkout"
[ -n "$RUNTIME_ROOT" ] || RUNTIME_ROOT="$HOME/.agent-inbox/runtime"
HOME_R="$HOME"; if [ -d "$HOME" ]; then HOME_R="$(cd "$HOME" && pwd -P)"; fi

g() { git -C "$MAIN" "$@"; }

NOW="$(date +%s)"
if stat -c %Y / >/dev/null 2>&1; then
  mtime() { stat -c %Y "$1" 2>/dev/null || echo 0; }
else
  mtime() { stat -f %m "$1" 2>/dev/null || echo 0; }
fi
iso() { [ "${1:-0}" -gt 0 ] 2>/dev/null || { echo "-"; return; }
  date -u -r "$1" +%Y-%m-%dT%H:%MZ 2>/dev/null || date -u -d "@$1" +%Y-%m-%dT%H:%MZ 2>/dev/null || echo "$1"; }
size_kb() { du -sk "$1" 2>/dev/null | awk '{print $1}' | sed -n 1p; }
human() { awk -v k="${1:-0}" 'BEGIN { split("K M G T", u, " "); i = 1; while (k >= 1024 && i < 4) { k /= 1024; i++ } printf (i == 1 ? "%d%s" : "%.1f%s"), k, u[i] }'; }

# A path that the sweep must never delete, whatever any check says.
forbidden_path() {
  local p="$1" f
  case "$p" in /|"") return 0 ;; esac
  for f in "$HOME" "$HOME_R"; do
    [ "$p" = "$f" ] && return 0
    case "$p" in "$f"/.agent-inbox|"$f"/.agent-inbox/*|"$f"/.claude*|"$f"/.copilot*) return 0 ;; esac
  done
  [ "$p" = "$MAIN" ] && return 0
  case "$p" in "$MAIN"/dist|"$MAIN"/dist/*|"$MAIN"/node_modules|"$MAIN"/node_modules/*|"$MAIN"/.git|"$MAIN"/.git/*) return 0 ;; esac
  # Inside the main checkout only build/ and out/ may go.
  case "$p" in "$MAIN"/build|"$MAIN"/out) return 1 ;; "$MAIN"/*) return 0 ;; esac
  return 1
}

# Anything (by mtime) changed in the last RECENT_MIN minutes under a path.
recent_tree() { [ -n "$(find "$1" -mmin -"$RECENT_MIN" -print -quit 2>/dev/null)" ]; }
recent_epoch() { [ "${1:-0}" -gt $((NOW - RECENT_S)) ] 2>/dev/null; }
commit_time() { git -C "$MAIN" log -1 --format=%ct "$1" 2>/dev/null || echo 0; }
reflog_time() { g log -g -1 --date=unix --format=%gd "$1" 2>/dev/null | sed -n 's/.*@{\([0-9]*\)}.*/\1/p'; }

PS_SNAPSHOT=""
# Full command lines (-ww: never truncated) and, where lsof exists, every
# process's working directory, so a shell sitting in a worktree counts as a use.
snapshot_ps() {
  PS_SNAPSHOT="$(ps -axww -o command= 2>/dev/null || ps -eww -o args= 2>/dev/null || true)"
  if command -v lsof >/dev/null 2>&1; then
    PS_SNAPSHOT="$PS_SNAPSHOT$NL$(lsof -nP -d cwd -Fn 2>/dev/null | sed -n 's/^n//p')"
  fi
}
in_use() { [ -n "$PS_SNAPSHOT" ] && printf '%s\n' "$PS_SNAPSHOT" | grep -F -q -- "$1"; }

# ---------------------------------------------------------------- PR states
# One `gh` call: number, state, head ref, head oid, base ref per line.
PRS=""
load_prs() {
  if ! command -v gh >/dev/null 2>&1; then
    echo "workspace-sweep: gh is not available; failing closed, nothing is removed" >&2
    exit 2
  fi
  local out n
  set -- pr list --state all --limit "$GH_LIMIT" --json number,state,headRefName,headRefOid,baseRefName \
    --jq '.[] | [.number, .state, .headRefName, .headRefOid, .baseRefName] | @tsv'
  [ -n "$REPO_SLUG" ] && set -- "$@" --repo "$REPO_SLUG"
  if ! out="$(cd "$MAIN" && gh "$@" 2>/dev/null)"; then
    echo "workspace-sweep: gh pr list failed (offline or not authenticated?); failing closed, nothing is removed" >&2
    exit 2
  fi
  n="$(printf '%s' "$out" | grep -c . || true)"
  if [ "$n" -ge "$GH_LIMIT" ]; then
    echo "workspace-sweep: gh returned $n PRs, the list may be incomplete; failing closed" >&2
    exit 2
  fi
  PRS="$out"
}
if [ -z "$REPO_SLUG" ]; then
  REPO_SLUG="$(g remote get-url origin 2>/dev/null | sed -n 's#^.*github\.com[:/]\([^/]*/[^/]*\)$#\1#p' | sed 's/\.git$//')"
fi

prs_where() { printf '%s\n' "$PRS" | awk -F '\t' -v c="$1" -v v="$2" -v s="${3:-}" 'NF >= 5 && $c == v && (s == "" || (s == "OPEN" ? $2 == "OPEN" : $2 != "OPEN"))'; }
open_head_pr() { prs_where 3 "$1" OPEN | awk -F '\t' 'NR == 1 { print $1 }'; }
open_base_pr() { prs_where 5 "$1" OPEN | awk -F '\t' 'NR == 1 { print $1 }'; }
pr_label() { # branch, head
  local line
  line="$( { [ -n "$1" ] && prs_where 3 "$1"; [ -n "$2" ] && prs_where 4 "$2"; } | sort -t "$TAB" -k1,1nr | awk -F '\t' '$2 == "OPEN" { print; exit } { a[NR] = $0 } END { if (a[1] != "") print a[1] }' | sed -n 1p)"
  [ -n "$line" ] || { echo none; return; }
  printf '%s\n' "$line" | awk -F '\t' '{ print "#" $1 " " $2 }'
}

# ---------------------------------------------------------------- checks
BASE_REF="origin/$DEFAULT_BRANCH"
checks_for() { # head, branch -> "a,b,c,d" subset or "-"
  local h="$1" b="$2" out="" oid
  if g rev-parse -q --verify "$BASE_REF^{commit}" >/dev/null 2>&1; then
    g merge-base --is-ancestor "$h" "$BASE_REF" 2>/dev/null && out="a"
  fi
  for oid in $( { [ -n "$b" ] && prs_where 3 "$b" CLOSED; prs_where 4 "$h" CLOSED; } | awk -F '\t' '{ print $4 }' | sort -u); do
    if [ "$oid" = "$h" ] || { g cat-file -e "$oid^{commit}" 2>/dev/null && g merge-base --is-ancestor "$h" "$oid" 2>/dev/null; }; then
      out="${out:+$out,}b"; break
    fi
  done
  local cherry
  if cherry="$(g cherry "$BASE_REF" "$h" 2>/dev/null)" && ! printf '%s\n' "$cherry" | grep -q '^+'; then
    out="${out:+$out,}c"
  fi
  if [ -n "$(g branch -r --contains "$h" 2>/dev/null | grep -v -- '->' | sed -n 1p)" ]; then
    out="${out:+$out,}d"
  fi
  echo "${out:--}"
}

# ---------------------------------------------------------------- worktrees
WT_LIST=""   # path<TAB>head<TAB>branch<TAB>flags, from `git worktree list --porcelain`
load_worktrees() {
  WT_LIST="$(g worktree list --porcelain | awk '
    function flush() { if (p != "") print p "\t" h "\t" b "\t" f; p = ""; h = ""; b = ""; f = "" }
    /^worktree / { flush(); p = substr($0, 10) }
    /^HEAD / { h = substr($0, 6) }
    /^branch / { b = substr($0, 8); sub(/^refs\/heads\//, "", b) }
    /^locked/ { f = f "locked," }
    /^prunable/ { f = f "prunable," }
    END { flush() }' | while IFS="$TAB" read -r p rest; do
      # git keeps the path as given; compare resolved paths (/var -> /private/var).
      [ -d "$p" ] && p="$(cd "$p" && pwd -P)"
      printf '%s\t%s\n' "$p" "$rest"
    done)"
}
wt_field() { printf '%s\n' "$WT_LIST" | awk -F '\t' -v p="$1" -v c="$2" '$1 == p { print $c; exit }'; }
branch_checked_out_in() { printf '%s\n' "$WT_LIST" | awk -F '\t' -v b="$1" '$3 == b { print $1; exit }'; }
MAIN_BRANCH="$(g symbolic-ref -q --short HEAD 2>/dev/null || true)"

V_ACTION=""; V_CHECKS=""; V_PR=""; V_HEAD=""; V_BRANCH=""; V_TIME=0
wt_verdict() { # path
  local p="$1" flags n
  V_HEAD="-"; V_BRANCH=""; V_CHECKS="-"; V_PR="-"; V_TIME="$(mtime "$p")"
  if [ -z "$(printf '%s\n' "$WT_LIST" | awk -F '\t' -v p="$p" '$1 == p { print 1 }')" ]; then
    if [ -f "$p/.git" ] && sed -n 's/^gitdir: //p' "$p/.git" | grep -q -F -- "$MAIN_COMMON/worktrees/"; then
      V_ACTION="keep: orphaned (not a registered worktree; never rm -rf, run git worktree prune/repair)"
    elif [ -e "$p/.git" ]; then V_ACTION="keep: not a worktree of this repository"
    else V_ACTION="keep: not a git worktree"; fi
    return
  fi
  flags="$(wt_field "$p" 4)"; V_HEAD="$(wt_field "$p" 2)"; V_BRANCH="$(wt_field "$p" 3)"
  case "$flags" in *prunable*) V_ACTION="keep: missing (prunable)"; return ;; esac
  forbidden_path "$p" && { V_ACTION="keep: protected path"; return; }
  V_PR="$(pr_label "$V_BRANCH" "$V_HEAD")"
  V_CHECKS="$(checks_for "$V_HEAD" "$V_BRANCH")"
  local ct; ct="$(commit_time "$V_HEAD")"; [ "$ct" -gt "$V_TIME" ] && V_TIME="$ct"
  case "$flags" in *locked*) V_ACTION="keep: locked"; return ;; esac
  if [ -n "$(git -C "$p" status --porcelain 2>/dev/null | sed -n 1p)" ] || ! git -C "$p" status --porcelain >/dev/null 2>&1; then
    V_ACTION="keep: uncommitted changes"; return
  fi
  if [ "$V_BRANCH" = "$DEFAULT_BRANCH" ]; then V_ACTION="keep: $DEFAULT_BRANCH"; return; fi
  n="$(open_head_pr "$V_BRANCH")"; [ -n "$V_BRANCH" ] && [ -n "$n" ] && { V_ACTION="keep: open PR #$n"; return; }
  n="$(open_base_pr "$V_BRANCH")"; [ -n "$V_BRANCH" ] && [ -n "$n" ] && { V_ACTION="keep: base of open PR #$n"; return; }
  if recent_epoch "$ct" || { [ -n "$V_BRANCH" ] && recent_epoch "$(reflog_time "refs/heads/$V_BRANCH")"; } || recent_tree "$p"; then
    V_ACTION="keep: changed in the last 2 h"; return
  fi
  in_use "$p" && { V_ACTION="keep: in use by a running process"; return; }
  [ "$V_CHECKS" = "-" ] && { V_ACTION="keep: unmerged (no safety check passed)"; return; }
  V_ACTION="remove"
}

# ---------------------------------------------------------------- branches
REMOVE_WTS=""   # worktrees proposed for removal, one path per line
br_verdict() { # branch, apply-phase(0|1)
  local b="$1" w n
  V_HEAD="$(g rev-parse -q --verify "refs/heads/$b" 2>/dev/null || echo -)"
  V_PR="$(pr_label "$b" "$V_HEAD")"; V_CHECKS="-"; V_TIME="$(commit_time "$V_HEAD")"
  local rt; rt="$(reflog_time "refs/heads/$b")"; [ -n "$rt" ] && [ "$rt" -gt "$V_TIME" ] && V_TIME="$rt"
  [ "$V_HEAD" = "-" ] && { V_ACTION="keep: gone"; return; }
  [ "$b" = "$DEFAULT_BRANCH" ] && { V_ACTION="keep: $DEFAULT_BRANCH"; return; }
  [ -n "$MAIN_BRANCH" ] && [ "$b" = "$MAIN_BRANCH" ] && { V_ACTION="keep: current branch of the main checkout"; return; }
  V_CHECKS="$(checks_for "$V_HEAD" "$b")"
  local after=""
  w="$(branch_checked_out_in "$b")"
  if [ -n "$w" ]; then
    if [ "$2" -eq 0 ] && printf '%s\n' "$REMOVE_WTS" | grep -q -x -F -- "$w"; then
      after=" (after its worktree)"
    else
      V_ACTION="keep: checked out in $w"; return
    fi
  fi
  n="$(open_head_pr "$b")"; [ -n "$n" ] && { V_ACTION="keep: open PR #$n"; return; }
  n="$(open_base_pr "$b")"; [ -n "$n" ] && { V_ACTION="keep: base of open PR #$n"; return; }
  recent_epoch "$V_TIME" && { V_ACTION="keep: changed in the last 2 h"; return; }
  [ "$V_CHECKS" = "-" ] && { V_ACTION="keep: unmerged (no safety check passed)"; return; }
  V_ACTION="remove$after"
}

rb_verdict() { # name, tip
  local b="$1" tip="$2" n
  V_HEAD="$tip"; V_PR="$(pr_label "$b" "$tip")"; V_CHECKS="-"; V_TIME="$(commit_time "$tip")"
  n="$(open_head_pr "$b")"; [ -n "$n" ] && { V_ACTION="keep: open PR #$n"; return; }
  n="$(open_base_pr "$b")"; [ -n "$n" ] && { V_ACTION="keep: base of open PR #$n"; return; }
  if [ -z "$(prs_where 3 "$b" CLOSED | awk -F '\t' -v t="$tip" '$4 == t')" ]; then
    V_ACTION="keep: tip is not the head of a merged or closed PR"; return
  fi
  V_CHECKS="b"
  recent_epoch "$V_TIME" && { V_ACTION="keep: changed in the last 2 h"; return; }
  V_ACTION="remove"
}

# ---------------------------------------------------------------- build/ and out/
build_verdict() { # dir, owning checkout
  local d="$1" owner="$2"
  V_TIME="$(mtime "$d")"; V_CHECKS="-"; V_PR="-"
  [ -L "$d" ] && { V_ACTION="keep: symlink"; return; }
  forbidden_path "$d" && { V_ACTION="keep: protected path"; return; }
  git -C "$owner" check-ignore -q "$(basename "$d")" 2>/dev/null || { V_ACTION="keep: not ignored by git"; return; }
  recent_tree "$d" && { V_ACTION="keep: changed in the last 2 h"; return; }
  in_use "$d" && { V_ACTION="keep: in use by a running process"; return; }
  V_ACTION="remove"
}

# ---------------------------------------------------------------- temp entries
# Prefixes are the literals this repository passes to mkdtemp/scratchDir (and
# shell mktemp templates), read at run time, so the list follows the code.
GENERIC=" tmp temp test tests repo home dir work root data out build scratch plain stage view worktree files "
PREFIX_RE=""; PREFIXES=""; REFUSED=""
derive_prefixes() {
  local dirs="" d f w raw q='"'"'"'`'
  for d in src test scripts electron; do [ -d "$REPO_DIR/$d" ] && dirs="$dirs $REPO_DIR/$d"; done
  [ -n "$dirs" ] || return 0
  # shellcheck disable=SC2086
  raw="$(
    grep -rhoE "(mkdtemp|mkdtempSync|scratchDir)\((path\.)?(join\([^$q]*, *)?[$q][^$q]*[$q]" $dirs 2>/dev/null |
      sed -E "s/.*[$q]([^$q]*)[$q]\$/\1/"
    grep -rhoE "mktemp [^|;)]*/[A-Za-z0-9._-]+XXXXXX" $dirs 2>/dev/null | sed -E 's#.*/([A-Za-z0-9._-]+)XXXXXX$#\1#'
    # One-argument wrappers such as `function temp(prefix) { return scratchDir(prefix) }`.
    for f in $(grep -rlE "(return|=>) *(scratchDir|mkdtempSync|mkdtemp)\([A-Za-z_]+\)" $dirs 2>/dev/null); do
      for w in $(awk '
        match($0, /function [A-Za-z_][A-Za-z0-9_]*\(/) { last = substr($0, RSTART + 9, RLENGTH - 10) }
        match($0, /(const|let) [A-Za-z_][A-Za-z0-9_]* = \(/) { s = substr($0, RSTART, RLENGTH); sub(/^(const|let) /, "", s); sub(/ = \($/, "", s); last = s }
        $0 ~ /(return|=>) *(scratchDir|mkdtempSync|mkdtemp)\([A-Za-z_]+\)/ && last != "" { print last }' "$f" | sort -u); do
        grep -hoE "(^|[^A-Za-z0-9_.])$w\([$q][^$q]*[$q]" "$f" | sed -E "s/.*[$q]([^$q]*)[$q]\$/\1/"
      done
    done
  )"
  local classified
  classified="$(printf '%s\n' "$raw" | sed 's/\${[^}]*}/*/g' | grep -E -x '[A-Za-z0-9._*-]+' | sort -u |
    awk -v generic="$GENERIC" '{
      stem = $0; sub(/\*.*/, "", stem); gsub(/^[._-]+|[._-]+$/, "", stem)
      print ((length(stem) < 4 || index(generic, " " stem " ") > 0) ? "R " : "P ") $0
    }')"
  PREFIXES="$(printf '%s\n' "$classified" | sed -n 's/^P / /p' | tr -d '\n')"
  REFUSED="$(printf '%s\n' "$classified" | sed -n 's/^R / /p' | tr -d '\n')"
  PREFIX_RE="$(printf '%s\n' "$classified" | sed -n 's/^P //p' | sed -e 's/\./\\./g' -e 's/\*/[^\/]+/g' | paste -s -d '|' -)"
}

TMP_R=""
resolve_tmp() {
  local t="${TMPDIR:-/tmp}"
  [ -d "$t" ] || { TMP_R=""; return; }
  t="$(cd "$t" && pwd -P)"
  # A TMPDIR that is /, home, or holds home or the main checkout is not swept.
  case "$t" in /|"$HOME"|"$HOME_R"|"$MAIN") TMP_R=""; return ;; esac
  case "$HOME_R/" in "$t"/*) TMP_R=""; return ;; esac
  case "$MAIN/" in "$t"/*) TMP_R=""; return ;; esac
  TMP_R="$t"
}
tmp_name_ok() { [ -n "$PREFIX_RE" ] && printf '%s\n' "$1" | grep -E -q -x "($PREFIX_RE)[A-Za-z0-9]{6}"; }
tmp_verdict() { # absolute entry path
  local e="$1" name="${1##*/}"
  V_TIME="$(mtime "$e")"; V_CHECKS="-"; V_PR="-"
  if [ -z "$TMP_R" ] || [ "$e" != "$TMP_R/$name" ] || ! tmp_name_ok "$name"; then
    V_ACTION="keep: outside \$TMPDIR or not a known prefix"; return
  fi
  forbidden_path "$e" && { V_ACTION="keep: protected path"; return; }
  [ -L "$e" ] && { V_ACTION="keep: symlink"; return; }
  [ -O "$e" ] || { V_ACTION="keep: not owned by this user"; return; }
  recent_tree "$e" && { V_ACTION="keep: changed in the last 2 h"; return; }
  in_use "$e" && { V_ACTION="keep: in use by a running process"; return; }
  V_ACTION="remove"
}

# ---------------------------------------------------------------- output
COUNT_REMOVE=0; COUNT_KEEP=0; RECLAIM_KB=0; COUNTS=""
CANDIDATES=""  # kind<TAB>key<TAB>extra, for --apply
emit() { # kind, path-or-ref, size-kb or "", extra (for apply)
  local kind="$1" key="$2" kb="$3" sz="-"
  [ -n "$kb" ] && sz="$(human "$kb")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$kind" "$key" "$sz" "$(iso "$V_TIME")" "$V_PR" "$V_CHECKS" "$V_ACTION"
  case "$V_ACTION" in
    remove*)
      COUNT_REMOVE=$((COUNT_REMOVE + 1)); RECLAIM_KB=$((RECLAIM_KB + ${kb:-0}))
      COUNTS="$COUNTS$kind$NL"
      CANDIDATES="$CANDIDATES$kind$TAB$key$TAB${4:-}$NL" ;;
    *) COUNT_KEEP=$((COUNT_KEEP + 1)) ;;
  esac
}

# ---------------------------------------------------------------- inventory
# Check (d) reads remote-tracking refs, so --apply never decides on stale ones.
[ "$APPLY" -eq 1 ] && FETCH=1
load_prs
if [ "$FETCH" -eq 1 ]; then
  g fetch --prune --quiet origin || { echo "workspace-sweep: git fetch --prune origin failed; failing closed, nothing is removed" >&2; exit 2; }
fi
load_worktrees
snapshot_ps
derive_prefixes
resolve_tmp

echo "# workspace-sweep: $([ "$APPLY" -eq 1 ] && echo apply || echo 'dry run (read-only)')"
echo "# main checkout: $MAIN (current branch: ${MAIN_BRANCH:-detached})"
echo "# worktree folder: $WT"
if [ "$FETCH" -eq 1 ]; then
  echo "# remote-tracking refs: fetched now ($([ "$APPLY" -eq 1 ] && echo '--apply implies --fetch' || echo '--fetch'))"
else
  fh="$MAIN_COMMON/FETCH_HEAD"
  echo "# remote-tracking refs: last fetched $( [ -f "$fh" ] && iso "$(mtime "$fh")" || echo 'unknown'); they may be stale (pass --fetch to refresh)"
fi
echo "# PR states: $(printf '%s' "$PRS" | grep -c . || true) PRs from gh${REPO_SLUG:+ ($REPO_SLUG)}"
echo "# temp prefixes ($(echo $PREFIXES | wc -w | tr -d ' ')):$PREFIXES"
[ -n "$REFUSED" ] && echo "# refused prefixes (too generic):$REFUSED"
if [ -n "$TMP_R" ]; then echo "# temp folder: $TMP_R"; else echo "# temp folder: not swept (TMPDIR missing, or it is /, home, or holds home or the main checkout)"; fi
printf 'kind\tpath-or-ref\tsize\tlast-change\tpr-state\tchecks\taction\n'

# Worktrees: every directory in the worktree folder, and registered ones elsewhere.
KEPT_CHECKOUTS="$MAIN$NL"
WT_PATHS="$( { [ -d "$WT" ] && find "$WT" -mindepth 1 -maxdepth 1 -type d -print; printf '%s\n' "$WT_LIST" | awk -F '\t' 'NR > 1 { print $1 }'; } | sort -u)"
IFS="$NL"
for p in $WT_PATHS; do
  [ -n "$p" ] && [ "$p" != "$MAIN" ] || continue
  case "$p" in "$WT"/*) ;; *)
    V_TIME="$(mtime "$p")"; V_PR="-"; V_CHECKS="-"; V_ACTION="keep: outside the worktree folder"
    emit worktree "$p" "" ""; continue ;;
  esac
  wt_verdict "$p"
  kb=""; [ -d "$p" ] && kb="$(size_kb "$p")"
  case "$V_ACTION" in
    remove) REMOVE_WTS="$REMOVE_WTS$p$NL" ;;
    # Only an idle, unmerged worktree has its build outputs swept: never open-PR,
    # locked, dirty, recent or in-use work.
    "keep: unmerged"*) KEPT_CHECKOUTS="$KEPT_CHECKOUTS$p$NL" ;;
  esac
  emit worktree "$p" "$kb" "$V_HEAD"
done

for b in $(g for-each-ref --format='%(refname:short)' refs/heads/); do
  br_verdict "$b" 0
  emit branch "$b" "" "$V_HEAD"
done

for line in $(g for-each-ref --format="%(refname:strip=3)$TAB%(objectname)" refs/remotes/origin/); do
  b="${line%%"$TAB"*}"; tip="${line#*"$TAB"}"
  case "$b" in HEAD|"$DEFAULT_BRANCH") continue ;; esac
  rb_verdict "$b" "$tip"
  emit remote "origin/$b" "" "$tip"
done

# build/ and out/ of the main checkout and idle kept worktrees (a removed worktree
# takes its own along).
for c in $KEPT_CHECKOUTS; do
  for sub in build out; do
    [ -n "$c" ] && [ -d "$c/$sub" ] || continue
    build_verdict "$c/$sub" "$c"
    emit build "$c/$sub" "$(size_kb "$c/$sub")" "$c"
  done
done

if [ -n "$TMP_R" ] && [ -n "$PREFIX_RE" ]; then
  for e in $(find "$TMP_R" -mindepth 1 -maxdepth 1 -print 2>/dev/null | grep -E "/($PREFIX_RE)[A-Za-z0-9]{6}\$" | sort); do
    tmp_verdict "$e"
    kb=""; [ -L "$e" ] || kb="$(size_kb "$e")"
    emit temp "$e" "$kb" ""
  done
fi
unset IFS

# Runtimes: report only (install-agents.sh and prune-runtimes.sh own removal).
if [ -d "$RUNTIME_ROOT" ] && [ -n "$(ls -A "$RUNTIME_ROOT" 2>/dev/null)" ]; then
  if command -v node >/dev/null 2>&1; then
    echo "# runtimes (report only): $(node "$REPO_DIR/scripts/runtime-payload.mjs" list --runtime-root "$RUNTIME_ROOT" 2>&1 | sed -n 1p)"
    echo "# runtime references (report only): $(node "$REPO_DIR/scripts/runtime-config.mjs" unused --runtime-root "$RUNTIME_ROOT" --home "$HOME" 2>&1 | sed -n 1p)"
  else
    echo "# runtimes: node unavailable, not reported"
  fi
else
  echo "# runtimes: none under $RUNTIME_ROOT"
fi

by_kind="$(printf '%s' "$COUNTS" | sort | uniq -c | awk '{ printf "%s%s %s", (NR > 1 ? ", " : ""), $1, $2 }')"
echo "# summary: remove $COUNT_REMOVE${by_kind:+ ($by_kind)}, keep $COUNT_KEEP, reclaimable $(human "$RECLAIM_KB")"

[ "$APPLY" -eq 1 ] || exit 0
[ "$COUNT_REMOVE" -gt 0 ] || { echo "# apply: nothing to remove"; exit 0; }

# ---------------------------------------------------------------- apply
# Fresh state, then each candidate is re-verified right before its deletion.
load_prs
snapshot_ps
DONE=0; REFUSED_N=0
did() { echo "# apply: removed $1 $2"; DONE=$((DONE + 1)); }
refuse() { echo "# apply: kept $1 $2: $3"; REFUSED_N=$((REFUSED_N + 1)); }
run_kind() {
  printf '%s' "$CANDIDATES" | awk -F '\t' -v k="$1" '$1 == k { print $2 "\t" $3 }'
}
IFS="$NL"
for line in $(run_kind worktree); do
  p="${line%%"$TAB"*}"; listed="${line#*"$TAB"}"
  load_worktrees
  wt_verdict "$p"
  if [ "$V_ACTION" != remove ]; then refuse worktree "$p" "${V_ACTION#keep: }"; continue; fi
  if [ "$V_HEAD" != "$listed" ]; then refuse worktree "$p" "HEAD moved since listing"; continue; fi
  if g worktree remove "$p"; then did worktree "$p"; else refuse worktree "$p" "git worktree remove refused"; fi
done
load_worktrees
for line in $(run_kind branch); do
  b="${line%%"$TAB"*}"; listed="${line#*"$TAB"}"
  br_verdict "$b" 1
  if [ "$V_ACTION" != remove ]; then refuse branch "$b" "${V_ACTION#keep: }"; continue; fi
  if [ "$V_HEAD" != "$listed" ]; then refuse branch "$b" "tip moved since listing"; continue; fi
  if g branch -D -q "$b"; then did branch "$b"; else refuse branch "$b" "git branch -D failed"; fi
done
for line in $(run_kind remote); do
  ref="${line%%"$TAB"*}"; b="${ref#origin/}"; listed="${line#*"$TAB"}"
  rb_verdict "$b" "$listed"
  if [ "$V_ACTION" != remove ]; then refuse remote "$ref" "${V_ACTION#keep: }"; continue; fi
  if ! live="$(g ls-remote --heads origin "refs/heads/$b")"; then refuse remote "$ref" "git ls-remote failed"; continue; fi
  live="${live%%"$TAB"*}"
  if [ "$live" != "$listed" ]; then refuse remote "$ref" "remote tip changed (now ${live:-gone}, listed $listed)"; continue; fi
  # The lease closes the gap between the re-read above and the delete.
  if g push --quiet --force-with-lease="refs/heads/$b:$listed" origin --delete "$b"; then did remote "$ref"; else refuse remote "$ref" "git push --delete failed"; fi
done
for line in $(run_kind build); do
  d="${line%%"$TAB"*}"; owner="${line#*"$TAB"}"
  [ -d "$d" ] || { refuse build "$d" "gone"; continue; }
  build_verdict "$d" "$owner"
  if [ "$V_ACTION" != remove ]; then refuse build "$d" "${V_ACTION#keep: }"; continue; fi
  if rm -rf -- "$d"; then did build "$d"; else refuse build "$d" "rm failed"; fi
done
listed_tmp="$TMP_R"
resolve_tmp
for line in $(run_kind temp); do
  e="${line%%"$TAB"*}"
  if [ -z "$TMP_R" ] || [ "$TMP_R" != "$listed_tmp" ]; then refuse temp "$e" "\$TMPDIR changed"; continue; fi
  case "$e" in /*) ;; *) refuse temp "$e" "not an absolute path"; continue ;; esac
  [ -e "$e" ] || [ -L "$e" ] || { refuse temp "$e" "gone"; continue; }
  tmp_verdict "$e"
  if [ "$V_ACTION" != remove ]; then refuse temp "$e" "${V_ACTION#keep: }"; continue; fi
  if rm -rf -- "$e"; then did temp "$e"; else refuse temp "$e" "rm failed"; fi
done
unset IFS
g worktree prune
echo "# apply: removed $DONE, kept $REFUSED_N on re-verification"
exit 0
