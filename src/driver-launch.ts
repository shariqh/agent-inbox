// Issue #412 step 3 — what an app launch's driver adds to step 2's: asks that
// only the human at the Agent Inbox app can approve, and the launch row the
// driver keeps current. Design: docs/superpowers/specs/2026-10-31-driven-sessions-design.md
// §4.2, §4.3, §6 and §7.
//
// Each ask is an `approval` question in `@sessions` with its choices as
// options, mapped by id in launch_asks. Electron main answers it by writing
// `reply = <option id>` and `reply_context = <signature>`, the MAC of
// launch-sign.ts over (item, the revision at filing, option id) under this
// launch's key, which main sends on fd 3. Only such a reply becomes an
// approval intent; anything else (an unsigned reply from the ordinary reply
// route, an older viewer, a forged or replayed signature, an option this ask
// does not offer) is logged and ignored: the ask stays open, and nothing is
// allowed or declined on its strength.
import type Database from 'better-sqlite3'
import type { AskChannel, DriverHooks } from './driver.js'
import { terminalSafe } from './driver-policy.js'
import { verifyApproval } from './launch-sign.js'
import { fileLaunchAsk, listLaunchAskReplies, recordLaunchProgress, settleLaunchAsk } from './store.js'

interface FiledAsk {
  revision: number
  choices: Array<{ id: string; approve: boolean }>
  /** The response revision last looked at, so one reply is judged once. */
  seen: number | null
}

export function appAsks(o: {
  db: Database.Database
  launchId: string
  launchKey: Buffer
  project: string
  stream: string
  log: (event: Record<string, unknown>) => void
}): AskChannel {
  const filed = new Map<string, FiledAsk>()
  return {
    where: 'in Agent Inbox',
    file(ask) {
      const { itemId, revision } = fileLaunchAsk(o.db, o.launchId, {
        project: '@sessions',
        stream: [o.project, o.stream].filter(Boolean).join(' · '),
        agent: 'copilot',
        session: ask.session,
        kind: 'question',
        // the viewer escapes HTML, but control and invisible characters still mislead
        title: terminalSafe(ask.title),
        detail: 'A session Agent Inbox drives is waiting for your approval.',
        next_step: 'Approve or decline in the Agent Inbox app.',
        action_owner: 'approval',
        impact: 'The agent waits until you answer.',
        context: terminalSafe(ask.context),
        options: ask.choices.map((choice) => ({ label: choice.label, detail: choice.detail })),
      }, ask.choices.map((choice) => ({ optionId: choice.id, label: choice.label })))
      filed.set(itemId, { revision, choices: ask.choices.map((c) => ({ id: c.id, approve: c.approve })), seen: null })
      return itemId
    },
    settle(itemId, outcome) {
      filed.delete(itemId)
      settleLaunchAsk(o.db, itemId, outcome)
    },
    answers() {
      const out: Array<{ itemId: string; approve: boolean }> = []
      for (const row of listLaunchAskReplies(o.db, o.launchId)) {
        const ask = filed.get(row.item_id)
        if (!ask || row.status !== 'open' || !row.reply || ask.seen === row.response_revision) continue
        ask.seen = row.response_revision
        const choice = ask.choices.find((c) => c.id === row.reply)
        const signed = choice !== undefined
          && verifyApproval(o.launchKey, { item: row.item_id, revision: ask.revision, optionId: choice.id }, row.reply_context)
        if (!choice || !signed) {
          o.log({ event: 'approval_refused', item: row.item_id, why: choice ? 'signature' : 'option' })
          continue
        }
        out.push({ itemId: row.item_id, approve: choice.approve })
      }
      return out
    },
  }
}

/** The launch row's progress, as the driver learns it. */
export function launchHooks(db: Database.Database, launchId: string): DriverHooks {
  return {
    host: (pid) => { recordLaunchProgress(db, launchId, { hostPid: pid }) },
    linked: (sessions) => { recordLaunchProgress(db, launchId, { sessions }) },
    usage: (usage) => { recordLaunchProgress(db, launchId, usage) },
  }
}
