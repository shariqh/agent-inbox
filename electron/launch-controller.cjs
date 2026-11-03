'use strict'
// Issue #412 step 3 — Electron main's control of driven sessions (design §4.3,
// §5.3, §7, §8, §9). Everything is injected, so it is tested without Electron:
// the switch, the key store, the viewer's own routes (main reaches the hub
// through them in every build, as it answers notifications), the env capture,
// the native confirmation and folder picker, the verified runtime and the
// driver's start.
//
// What the renderer may send is checked here, exactly: a known repository
// folder (or none, for main's own folder dialog), a mode, an optional model and
// effort from Copilot's own lists, bounded budgets and the task. Never a path
// it chose, an executable, argv or env. Main builds the native confirmation
// itself from those checked facts, and the spec it sends is exactly what that
// dialog showed. While the switch is off nothing here captures an env, resolves
// a runtime or spawns anything (§9 e). Once a quit has begun, nothing starts.
//
// #432: the request may ask for `worktree: true` and nothing more. Main plans
// the worktree's path and branch itself (session-worktree.cjs), shows both in
// the confirmation, and sends them in the spec; the driver creates it.
const path = require('node:path')
const { isRepositoryTop, planWorktree, worktreeProblem, worktreeRootProblem } = require('./session-worktree.cjs')

const LAUNCH_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const ITEM_ID = /^[A-Za-z0-9-]{1,128}$/
const OPTION_ID = /^[A-Za-z0-9_-]{1,64}$/
const MODEL = /^[A-Za-z0-9._-]{1,64}$/
const EFFORTS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
const BUDGETS = { activeMs: { min: 60_000, max: 8 * 60 * 60_000 }, toolCalls: { min: 1, max: 2000 } }
const MAX_PROMPT = 64 * 1024
const PROMPT_PREVIEW = 300
// creating a worktree of a large checkout takes time (§2); other starts keep the driver's 30 s
const WORKTREE_STATUS_MS = 150_000
// #432 §5: the cap on sessions at once, a setting of 1 to 8; the terminal driver keeps its own 2
const DEFAULT_MAX_SESSIONS = 4
// folders main's own dialog chose, which a later start may name (#432)
const CHOSEN_KEPT = 20

const MODES = Object.freeze({
  ask: {
    label: 'Ask for everything',
    copy: 'Each tool call asks you first, except what your own Copilot settings already allow.',
  },
  'read-only': {
    label: 'Read-only',
    copy: 'File-edit tools are denied; shell commands still ask. This does not make writes impossible.',
  },
  plan: {
    label: 'Plan first',
    copy: 'The agent writes a plan first; once you approve it, each tool call asks.',
  },
  edits: {
    label: 'Edits in the worktree',
    copy: 'File edits inside the session’s folder (its worktree, when it has one) run without asking, never a .git folder or file; shell commands, network and anything outside the folder still ask. An edited file can change what a command you allow then runs.',
  },
})

const isRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
const exactKeys = (value, required, optional = []) =>
  required.every((key) => key in value) && Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
const inBounds = (value, { min, max }) => Number.isSafeInteger(value) && value >= min && value <= max

/** The renderer's New session request, checked exactly, or null. */
function launchRequest(value) {
  if (!isRecord(value) || !exactKeys(value, ['root', 'mode', 'budgets', 'prompt'], ['model', 'reasoningEffort', 'worktree'])) return null
  // #432: only the wish; never a path, branch or root of the renderer's
  if (value.worktree !== undefined && value.worktree !== true) return null
  if (value.root !== null && (typeof value.root !== 'string' || !path.isAbsolute(value.root) || value.root.length > 4096 || value.root.includes('\0'))) return null
  if (!Object.prototype.hasOwnProperty.call(MODES, value.mode)) return null
  if (value.model !== undefined && (typeof value.model !== 'string' || !MODEL.test(value.model))) return null
  if (value.reasoningEffort !== undefined && !EFFORTS.has(value.reasoningEffort)) return null
  if (!isRecord(value.budgets) || !exactKeys(value.budgets, ['activeMs', 'toolCalls'])) return null
  if (!inBounds(value.budgets.activeMs, BUDGETS.activeMs) || !inBounds(value.budgets.toolCalls, BUDGETS.toolCalls)) return null
  if (typeof value.prompt !== 'string' || !value.prompt.trim() || value.prompt.length > MAX_PROMPT) return null
  return {
    root: value.root,
    mode: value.mode,
    ...(value.model === undefined ? {} : { model: value.model }),
    ...(value.reasoningEffort === undefined ? {} : { reasoningEffort: value.reasoningEffort }),
    budgets: { activeMs: value.budgets.activeMs, toolCalls: value.budgets.toolCalls },
    prompt: value.prompt,
    ...(value.worktree === true ? { worktree: true } : {}),
  }
}

/** The renderer's approval, checked exactly, or null. */
function approvalRequest(value) {
  if (!isRecord(value) || !exactKeys(value, ['item', 'revision', 'optionId'])) return null
  if (typeof value.item !== 'string' || !ITEM_ID.test(value.item)) return null
  if (!Number.isSafeInteger(value.revision) || value.revision < 0) return null
  if (typeof value.optionId !== 'string' || !OPTION_ID.test(value.optionId)) return null
  return { item: value.item, revision: value.revision, optionId: value.optionId }
}

// Text main shows in its own dialogs. C0 controls but the newline, DEL and C1;
// every Unicode format character (Cf: bidi marks, embeddings, overrides and
// isolates, zero-width characters, word joiners and invisible operators, the
// Arabic letter mark, the BOM, tags); and the line and paragraph separators
// (Zl, Zp), which macOS alerts draw as line breaks. Each becomes visible, so
// agent-controlled text cannot hide, reorder or add lines. The driver's
// terminalSafe (src/driver-policy.ts) escapes the same set; a test pins both.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\p{Cf}\p{Zl}\p{Zp}]/gu

function displaySafe(text) {
  return String(text)
    .replace(/\r\n?/g, '\n')
    .replace(UNSAFE, (ch) => {
      const code = ch.codePointAt(0)
      return code <= 0x9f ? `\\x${code.toString(16).padStart(2, '0')}` : `<U+${code.toString(16).toUpperCase().padStart(4, '0')}>`
    })
}

// One line from at most DISPLAY_MAX code points: a project or folder name, which
// an agent can set (MCP register) and a folder name can carry newlines. Cut on
// the raw text first, then escaped, so the cut never splits an escape; the
// result stays bounded (each code point escapes to at most 10 characters).
// `tail` keeps the end instead, for a worktree path whose last folder names its branch (#432).
const DISPLAY_MAX = 120
function displayLine(text, { tail = false } = {}) {
  const chars = Array.from(String(text))
  const long = chars.length > DISPLAY_MAX
  const kept = !long ? chars.join('') : tail ? chars.slice(chars.length - DISPLAY_MAX + 1).join('') : chars.slice(0, DISPLAY_MAX - 1).join('')
  const line = displaySafe(kept).replace(/\n/g, '\\x0a')
  return long ? (tail ? `…${line}` : `${line}…`) : line
}

function duration(ms) {
  const minutes = Math.round(ms / 60_000)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${rest} min`
  return rest ? `${hours} h ${rest} min` : `${hours} h`
}

/** The native confirmation main builds itself (§8): what it shows is what it sends. */
function confirmation({ project, folder, worktree, mode, model, reasoningEffort, budgets, prompt }) {
  const preview = prompt.length > PROMPT_PREVIEW ? `${prompt.slice(0, PROMPT_PREVIEW)}…` : prompt
  return {
    message: `Start a Copilot session in ${displayLine(project)}?`,
    detail: [
      `Folder: ${displayLine(folder)}`,
      ...(worktree ? [
        `Worktree: ${displayLine(worktree.path, { tail: true })}`,
        `Branch: ${displayLine(worktree.branch)}, from your checkout’s last commit. Uncommitted changes stay in your checkout.`,
        'Creating it runs your repository’s checkout hooks.',
        ...(worktree.shared ? ['Another session Agent Inbox started is running in this folder itself, not in a worktree.'] : []),
      ] : []),
      `Mode: ${MODES[mode].label}. ${MODES[mode].copy}`,
      `Model: ${model ?? 'your Copilot default'}${reasoningEffort ? `, reasoning effort ${reasoningEffort}` : ''}`,
      `Budgets: up to ${duration(budgets.activeMs)} of active turn time and ${budgets.toolCalls} tool calls.`,
      'Once any shell command is allowed, the session can run anything, in its folder and beyond. Answer each approval with that in mind.',
      '',
      `Task: ${displaySafe(preview)}`,
    ].join('\n'),
    buttons: ['Start', 'Cancel'],
  }
}

const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`

/**
 * #432 §5: Remove worktree's own confirmation, from what `worktree inspect`
 * found. Discard is a separate button, offered only when there are changes,
 * and bound to the status that was inspected.
 */
function removalConfirmation({ project, path: folder, branch, missing, dirty, ahead, upstream, examples = [], noDiscard = null }) {
  const changes = plural(dirty, 'change', 'changes')
  const discard = dirty > 0 && !noDiscard
  const buttons = discard ? ['Remove', `Discard ${changes} and remove`, 'Cancel'] : ['Remove', 'Cancel']
  // what Discard would delete, named: agent-controlled names, each made visible on one line (review of #446)
  const shown = (Array.isArray(examples) ? examples : []).filter((name) => typeof name === 'string').slice(0, 5)
  const more = dirty - shown.length
  return {
    message: `Remove the worktree of ${displayLine(project)}?`,
    detail: [
      `Worktree: ${displayLine(folder, { tail: true })}`,
      `The branch ${displayLine(branch)} and its ${plural(ahead, 'commit', 'commits')} stay in your repository${upstream ? '.' : '; it has no upstream, so they are only there.'}`,
      missing
        ? 'Its folder is already gone: this removes only git’s record of it.'
        : 'Ignored files such as node_modules are deleted.',
      ...(dirty > 0 ? [
        `It has ${plural(dirty, 'uncommitted change', 'uncommitted changes')}: ${shown.map((name) => displayLine(name)).join(', ')}${more > 0 ? ` and ${more} more` : ''}.`,
        noDiscard ? `Remove refuses while they are there. ${displaySafe(noDiscard).replace(/\n/g, ' ')}` : 'Remove refuses while they are there; Discard deletes them.',
      ] : []),
    ].join('\n'),
    buttons,
  }
}

const sleep = (ms, value) => new Promise((resolve) => setTimeout(() => resolve(value), ms))

/**
 * The launches to name in the quit prompt (§7). A start already past the gate
 * gets a short, separate wait to write its row; whatever it does, the running
 * launches are always read, under their own bound, so a start still in
 * progress (a dialog left open, a slow shell) never hides them. The gate is
 * already closed (beginAppQuit), so such a start spawns nothing later.
 */
async function runningAtQuit(controller, { settleMs = 1500, readMs = 3000 } = {}) {
  await Promise.race([controller.settled(), sleep(settleMs)])
  const running = await Promise.race([controller.running().catch(() => []), sleep(readMs, [])])
  return Array.isArray(running) ? running : []
}

/**
 * The quit prompt (§7): drivers keep running unless the human stops them all.
 * No Cancel: the quit has already begun (beginAppQuit), and it is not undone.
 */
async function quitChoice({ running, showMessageBox }) {
  const lines = running.map((launch) => `• ${displayLine(launch.project)} · ${MODES[launch.mode]?.label ?? launch.mode}`)
  const { response } = await showMessageBox({
    type: 'question',
    message: `${running.length === 1 ? 'A session' : `${running.length} sessions`} Agent Inbox started ${running.length === 1 ? 'is' : 'are'} still running.`,
    detail: [
      ...lines,
      '',
      'They can keep running after Agent Inbox quits, but their approvals wait until you open it again.',
    ].join('\n'),
    buttons: ['Keep running', 'Stop all'],
    defaultId: 0,
    cancelId: 0,
    noLink: true,
  })
  return response === 1 ? 'stop' : 'keep'
}

const refused = (error, extra = {}) => ({ ok: false, error, ...extra })

// The captured env through the driver's denylist (§8), applied here too so
// nothing of Electron's or Agent Inbox's own reaches the spec: no ELECTRON_*,
// AGENT_INBOX_*, NODE_OPTIONS, or COPILOT_* but COPILOT_HOME and
// COPILOT_GITHUB_TOKEN. The driver applies it again and adds its own settings.
function launchEnv(env) {
  const out = {}
  for (const [name, value] of Object.entries(env)) {
    if (typeof value !== 'string') continue
    if (name.startsWith('ELECTRON_') || name.startsWith('AGENT_INBOX_') || name === 'NODE_OPTIONS') continue
    if (name.startsWith('COPILOT_') && name !== 'COPILOT_HOME' && name !== 'COPILOT_GITHUB_TOKEN') continue
    out[name] = value
  }
  return out
}

function createLaunchController(deps) {
  const {
    platform, isEnabled, keys, viewer, captureEnv, confirm, chooseFolder, driverRuntime, startDriver, hubPath, driverEnv,
    randomUUID, realDirectory, processStart, kill, worktreeSettings, chooseWorktreeFolder,
    runWorktree, ask, openTerminal, sessionCap,
  } = deps
  // #432 §1: session worktrees go under <hub dir>/worktrees unless Settings names another folder
  const defaultWorktreeRoot = path.join(path.dirname(hubPath), 'worktrees')
  // #432: the real folders main's own dialog chose (chooseFolder), newest last. A start may
  // name one as its root, like a folder the hub knows: still never a path the page made up.
  const chosenFolders = []
  let quitting = false
  // the starts in flight, so the quit prompt can wait for the launch rows they write
  const starting = new Set()

  // every action but Stop and Close needs the switch on, macOS and a key store
  function blocked() {
    if (quitting) return refused('Agent Inbox is quitting, so nothing was started.')
    if (platform !== 'darwin') return refused('Starting sessions from Agent Inbox is available on macOS only.')
    if (isEnabled() !== true) return refused('Starting sessions from Agent Inbox is off. Turn it on in Settings → Agent sessions.')
    if (!keys.available()) return refused('This Mac cannot encrypt the key that signs approvals, so Agent Inbox does not start sessions.')
    return null
  }

  function runtimeOrRefusal() {
    const runtime = driverRuntime()
    return !runtime || runtime.error ? refused(runtime?.error ?? 'The driver could not be found.') : { runtime }
  }

  // after the human confirmed: the login shell runs only for a launch they asked for
  async function environment(folder) {
    const env = await captureEnv(folder)
    if (!env.ok) {
      return refused(env.reason === 'timeout'
        ? 'Your shell took longer than 10 seconds to start in that folder. Try again (Refresh environment).'
        : 'Agent Inbox could not read your shell environment in that folder. Try again (Refresh environment).', { reason: 'environment' })
    }
    return { env: launchEnv(env.env) }
  }

  async function spawnDriver(launchId, spec) {
    // a quit or a switch turned off while the dialog was open starts nothing
    const late = blocked()
    if (late) return late
    // the human's cap, read for this start: the driver counts every running driver against it (#432 §5)
    const maxDrivers = await maxSessions()
    const launchKey = await keys.launchKey(launchId)
    // ...and again after those reads, immediately before anything spawns
    const later = blocked()
    if (later) return later
    // the runtime is verified again here, not only before a dialog that may have stayed open for minutes (#435)
    const found = runtimeOrRefusal()
    if (!found.runtime) return found
    return startDriver({
      platform, node: found.runtime.node, entry: found.runtime.entry, launchId, hubPath,
      logPath: path.join(path.dirname(hubPath), 'launches', launchId, 'driver.log'),
      env: driverEnv, spec: { ...spec, maxDrivers, launchKey: launchKey.toString('base64') },
      ...(spec.worktree ? { timeoutMs: WORKTREE_STATUS_MS } : {}),
    })
  }

  async function maxSessions() {
    const chosen = await sessionCap.read().catch(() => null)
    return Number.isSafeInteger(chosen) && chosen >= 1 && chosen <= 8 ? chosen : DEFAULT_MAX_SESSIONS
  }

  async function worktreeRoot() {
    const chosen = await worktreeSettings.read().catch(() => null)
    return { path: chosen ?? defaultWorktreeRoot, isDefault: chosen === null }
  }

  function guarded(work) {
    const run = (async () => {
      try {
        return await work()
      } catch {
        return refused('The session could not be started.')
      }
    })()
    starting.add(run)
    run.finally(() => starting.delete(run))
    return run
  }

  return Object.freeze({
    /**
     * Why the switch may not be turned on here, or null: macOS, no quit begun
     * and, when turning it on (`withKeys`), safeStorage. Reading the switch
     * never touches safeStorage.
     */
    canEnable({ withKeys = false } = {}) {
      if (quitting) return refused('Agent Inbox is quitting.')
      if (platform !== 'darwin') return refused('Starting sessions from Agent Inbox is available on macOS only.')
      if (withKeys && !keys.available()) return refused('This Mac cannot encrypt the key that signs approvals, so Agent Inbox does not start sessions.')
      return null
    },

    /** What Settings and the New session dialog may offer. */
    available() {
      const why = blocked()
      return { enabled: isEnabled() === true, available: why === null, ...(why ? { error: why.error } : {}) }
    },

    start(value) {
      const why = blocked()
      if (why) return Promise.resolve(why)
      const request = launchRequest(value)
      if (!request) return Promise.resolve(refused('The new session request is not valid.'))
      return guarded(async () => {
        let folder
        let project
        if (request.root !== null) {
          const known = (await viewer.getJson('/api/launch-folders')) ?? []
          const entry = Array.isArray(known) ? known.find((f) => f && f.root === request.root) : undefined
          if (!entry && !chosenFolders.includes(request.root)) return refused('That folder is not one Agent Inbox knows. Choose it with Choose folder… instead.')
          folder = request.root
          project = typeof entry?.project === 'string' ? entry.project : path.basename(folder)
        } else {
          folder = await chooseFolder()
          if (!folder) return refused('No folder was chosen.', { cancelled: true })
          project = path.basename(folder)
        }
        const real = realDirectory(folder)
        if (!real) return refused('That folder does not exist any more.')
        const found = runtimeOrRefusal()
        if (!found.runtime) return found
        // made before the confirmation, so it shows the worktree's final names (#432 §1)
        const launchId = randomUUID()
        let worktree = null
        if (request.worktree) {
          const root = (await worktreeRoot()).path
          const plan = planWorktree({ root, project, folder: real, task: request.prompt, launchId })
          const problem = worktreeProblem({ folder: real, root, defaultRoot: defaultWorktreeRoot, plan })
          if (problem) return refused(problem)
          // another session of this app editing the checkout itself (§3)
          const launches = await viewer.getJson('/api/launches')
          const shared = Array.isArray(launches) && launches.some((l) => l && l.status === 'running' && l.cwd === real && !l.worktree_path)
          worktree = { ...plan, shared }
        }
        const facts = {
          project, folder: real, worktree, mode: request.mode, model: request.model, reasoningEffort: request.reasoningEffort,
          budgets: request.budgets, prompt: request.prompt,
        }
        if (!(await confirm(confirmation(facts)))) return refused('Not started.', { cancelled: true })
        // a quit begun, or the switch turned off, while the dialog was open runs no login shell
        const late = blocked()
        if (late) return late
        // the checkout's env: the worktree does not exist yet, and holds the same committed files
        const ready = await environment(real)
        if (!ready.env) return ready
        return spawnDriver(launchId, {
          v: 1, kind: 'new', launchId, host: 'copilot', cwd: real, mode: request.mode,
          ...(request.model ? { model: request.model } : {}),
          ...(request.reasoningEffort ? { reasoningEffort: request.reasoningEffort } : {}),
          budgets: request.budgets, prompt: request.prompt, env: ready.env,
          ...(worktree ? { worktree: { path: worktree.path, branch: worktree.branch } } : {}),
        })
      })
    },

    // Resume and send's first half (§5.3, §7): the click is the gesture, so no
    // second confirmation; the launch must still be parked, and the switch on.
    resume(id) {
      const why = blocked()
      if (why) return Promise.resolve(why)
      if (typeof id !== 'string' || !LAUNCH_ID.test(id)) return Promise.resolve(refused('The launch is not valid.'))
      return guarded(async () => {
        const launch = await viewer.getJson(`/api/launches/${id}`)
        if (!launch || launch.status !== 'parked') return refused('This session is not parked.')
        const real = realDirectory(launch.cwd)
        if (!real) {
          return refused(typeof launch.branch === 'string' && launch.branch
            ? `The session’s folder does not exist any more. Its branch ${launch.branch} is still in your repository.`
            : 'The session’s folder does not exist any more.')
        }
        const found = runtimeOrRefusal()
        if (!found.runtime) return found
        // the launch read was an await: a quit or the switch may have changed since
        const late = blocked()
        if (late) return late
        const ready = await environment(real)
        if (!ready.env) return ready
        return spawnDriver(id, { v: 1, kind: 'resume', launchId: id, env: ready.env })
      })
    },

    /**
     * #432: New session's Choose folder…, before Start: main's own dialog picks
     * the folder and says whether it is a repository's top (lstat, no git), so
     * the page can untick New worktree for one that is not.
     */
    async chooseFolder() {
      const why = blocked()
      if (why) return why
      const folder = await chooseFolder()
      if (!folder) return refused('No folder was chosen.', { cancelled: true })
      const real = realDirectory(folder)
      if (!real) return refused('That folder does not exist any more.')
      const at = chosenFolders.indexOf(real)
      if (at !== -1) chosenFolders.splice(at, 1)
      chosenFolders.push(real)
      if (chosenFolders.length > CHOSEN_KEPT) chosenFolders.shift()
      return { ok: true, folder: real, project: path.basename(real), repository: isRepositoryTop(real) }
    },

    /** #432 §5: the cap on sessions at once, read only with the switch on. */
    async maxSessions() {
      return blocked() ? null : maxSessions()
    },

    async setMaxSessions(value) {
      const why = blocked()
      if (why) return why
      if (!Number.isSafeInteger(value) || value < 1 || value > 8) return refused('Choose 1 to 8 sessions.')
      const saved = await sessionCap.write(value).catch(() => null)
      if (!saved) return refused('The setting could not be saved.')
      return saved.refused ? refused('A newer Agent Inbox owns this setting.') : { ok: true, maxSessions: value }
    },

    /** #432: the folder session worktrees go under, read only with the switch on. */
    async worktreeRoot() {
      return blocked() ? null : worktreeRoot()
    },

    /** #432: choose the worktree folder through main's own dialog; the renderer names none. */
    async chooseWorktreeRoot() {
      const why = blocked()
      if (why) return why
      const folder = await chooseWorktreeFolder()
      if (!folder) return refused('No folder was chosen.', { cancelled: true })
      const real = realDirectory(folder)
      const problem = real ? worktreeRootProblem(real) : 'That folder does not exist any more.'
      if (problem) return refused(problem)
      const saved = await worktreeSettings.write(real).catch(() => null)
      if (!saved) return refused('The setting could not be saved.')
      return saved.refused ? refused('A newer Agent Inbox owns this setting.') : { ok: true, worktreeRoot: { path: real, isDefault: false } }
    },

    async resetWorktreeRoot() {
      const why = blocked()
      if (why) return why
      const saved = await worktreeSettings.write(null).catch(() => null)
      if (!saved) return refused('The setting could not be saved.')
      return saved.refused ? refused('A newer Agent Inbox owns this setting.') : { ok: true, worktreeRoot: { path: defaultWorktreeRoot, isDefault: true } }
    },

    // #432 §5: Remove worktree on an ended launch: inspect, the human's own
    // choice in main's dialog, then remove; the branch always stays
    async removeWorktree(id) {
      const why = blocked()
      if (why) return why
      if (typeof id !== 'string' || !LAUNCH_ID.test(id)) return refused('The launch is not valid.')
      try {
        const launch = await viewer.getJson(`/api/launches/${id}`)
        if (!launch || typeof launch.worktree_path !== 'string' || typeof launch.checkout_root !== 'string' || launch.worktree_removed_at) {
          return refused('This session has no worktree to remove.')
        }
        if (launch.status !== 'ended') return refused('End the session before removing its worktree.')
        const checkout = realDirectory(launch.checkout_root)
        if (checkout !== launch.checkout_root) return refused('Its repository is not there any more.')
        const found = runtimeOrRefusal()
        if (!found.runtime) return found
        // as Resume does: the shell runs for this click only, in the checkout
        const ready = await environment(checkout)
        if (!ready.env) return ready
        const command = (verb, discard) => runWorktree({
          platform, node: found.runtime.node, entry: found.runtime.entry, verb, launchId: id, hubPath, env: ready.env,
          ...(discard ? { discard } : {}),
        })
        const seen = await command('inspect')
        if (!seen?.ok) return refused(seen?.error ?? 'The worktree could not be read.')
        const text = removalConfirmation({ project: launch.project, ...seen })
        const choice = text.buttons[await ask(text)]
        if (choice === undefined || choice === 'Cancel') return refused('Not removed.', { cancelled: true })
        const late = blocked()
        if (late) return late
        const removed = await command('remove', choice === 'Remove' ? undefined : seen.status)
        return removed?.ok ? { ok: true } : refused(removed?.error ?? 'The worktree was not removed.')
      } catch {
        return refused('The worktree was not removed.')
      }
    },

    // #432 §6: Open in Terminal, on the path a fresh row read names, only while it is its own real folder
    async openWorktree(id) {
      const why = blocked()
      if (why) return why
      if (typeof id !== 'string' || !LAUNCH_ID.test(id)) return refused('The launch is not valid.')
      const launch = await viewer.getJson(`/api/launches/${id}`)
      if (!launch || typeof launch.worktree_path !== 'string' || launch.worktree_removed_at) return refused('This session has no worktree to open.')
      if (realDirectory(launch.worktree_path) !== launch.worktree_path) return refused('Its worktree is not there any more.')
      return (await openTerminal(launch.worktree_path)) ? { ok: true } : refused('Terminal could not be opened.')
    },

    async stop(id) {
      if (typeof id !== 'string' || !LAUNCH_ID.test(id)) return refused('The launch is not valid.')
      const result = await viewer.postJson(`/api/launches/${id}/stop`)
      return result?.ok ? { ok: true, status: result.status } : refused('This session is not running.')
    },

    // Close on a lost launch (§7): the viewer re-checks the lease is stale in
    // one transaction and hands back the child; its group is killed only while
    // that process still started when the driver recorded it.
    async close(id) {
      if (typeof id !== 'string' || !LAUNCH_ID.test(id)) return refused('The launch is not valid.')
      const result = await viewer.postJson(`/api/launches/${id}/close`)
      if (!result?.ok) return refused(result?.reason === 'driver_alive' ? 'This session’s driver is still running; stop it instead.' : 'This session is not lost.')
      let killed = false
      if (Number.isSafeInteger(result.childPgid) && result.childPgid > 1 && typeof result.childStartedAt === 'string') {
        if ((await processStart(result.childPgid)) === result.childStartedAt) {
          try {
            kill(-result.childPgid, 'SIGTERM')
            killed = true
          } catch { /* gone */ }
        }
      }
      return { ok: true, killed }
    },

    // §4.3: main signs (item, the revision at filing, option) under the
    // launch's key and writes the reply; the driver verifies it.
    async approve(value) {
      const why = blocked()
      if (why) return why
      const request = approvalRequest(value)
      if (!request) return refused('The approval is not valid.')
      const ask = await viewer.getJson(`/api/launch-asks/${request.item}`)
      if (!ask || typeof ask.launch_id !== 'string' || !Number.isSafeInteger(ask.filed_revision) || !Array.isArray(ask.options)) {
        return refused('This approval is no longer open.')
      }
      if (!ask.options.some((o) => o && o.optionId === request.optionId)) return refused('That is not one of this approval’s choices.')
      const signature = await keys.sign(ask.launch_id, { item: request.item, revision: ask.filed_revision, optionId: request.optionId })
      const result = await viewer.postJson(`/api/launch-asks/${request.item}/answer`, { revision: request.revision, optionId: request.optionId, signature })
      if (result?.ok) return { ok: true }
      return refused(result?.reason === 'revision' ? 'This approval changed; look at it again.' : 'This approval is no longer open.')
    },

    /** The launches whose driver is running now, for the quit prompt. */
    async running() {
      const launches = await viewer.getJson('/api/launches')
      if (!Array.isArray(launches)) return []
      const out = []
      for (const launch of launches) {
        if (!launch || launch.status !== 'running' || !LAUNCH_ID.test(launch.id)) continue
        const fresh = await viewer.getJson(`/api/launches/${launch.id}`)
        if (fresh?.driver === 'running') out.push({ id: launch.id, project: launch.project, mode: launch.mode })
      }
      return out
    },

    async stopAll(launches) {
      for (const launch of launches) await viewer.postJson(`/api/launches/${launch.id}/stop`).catch(() => null)
    },

    /** The launch gate (§7): once a quit begins, no start or resume spawns anything. */
    beginQuit() {
      quitting = true
    },
    /**
     * Settles once every start or resume in flight has settled: one that got
     * past the gate before the quit began has spawned and written its row.
     */
    settled: () => Promise.allSettled([...starting]).then(() => undefined),
  })
}

module.exports = {
  MODES, approvalRequest, confirmation, createLaunchController, displayLine, removalConfirmation, displaySafe, launchEnv, launchRequest, quitChoice, runningAtQuit,
}
