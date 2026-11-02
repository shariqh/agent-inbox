// Issue #412 step 3 — signed approvals (design §4.3, §14.3). Only the human at
// the Agent Inbox app approves an app launch's ask: Electron main signs
//
//   HMAC-SHA256(launchKey, frame(APPROVAL_LABEL, item, revision, optionId))
//
// where `launchKey = HMAC-SHA256(masterKey, frame('agent-inbox/launch-key/v1', launchId))`,
// `masterKey` is held only in Electron safeStorage, and `frame` prefixes every
// part with its UTF-8 byte length (4 bytes, big-endian), so no two inputs share
// bytes. The fixed labels keep these MACs apart from anything else the master
// key signs (it is the mesh console key, mesh §3). Main hands the driver the
// launch key on fd 3; the driver only verifies. Pure Node core.
import { createHmac, timingSafeEqual } from 'node:crypto'

const APPROVAL_LABEL = 'agent-inbox/launch-approval/v1'
export const LAUNCH_KEY_BYTES = 32

export interface ApprovalInput {
  item: string
  /** The ask's response revision when the driver filed it (launch_asks.revision). */
  revision: number
  optionId: string
}

function frame(parts: readonly string[]): Buffer {
  const chunks: Buffer[] = []
  for (const part of parts) {
    const bytes = Buffer.from(part, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    chunks.push(length, bytes)
  }
  return Buffer.concat(chunks)
}

function approvalMac(launchKey: Buffer, input: ApprovalInput): Buffer {
  return createHmac('sha256', launchKey).update(frame([APPROVAL_LABEL, input.item, String(input.revision), input.optionId])).digest()
}

/** Whether `signature` (lowercase hex) is main's MAC over exactly this ask, revision and option. */
export function verifyApproval(launchKey: Buffer, input: ApprovalInput, signature: string | null): boolean {
  if (launchKey.length !== LAUNCH_KEY_BYTES || typeof signature !== 'string' || !/^[0-9a-f]{64}$/.test(signature)) return false
  if (!Number.isInteger(input.revision) || input.revision < 0) return false
  return timingSafeEqual(approvalMac(launchKey, input), Buffer.from(signature, 'hex'))
}
