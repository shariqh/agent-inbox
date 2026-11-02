// test/launch-fixtures.ts — what Electron main does for an app launch (#412
// step 3), written independently of src/launch-sign.ts so the tests pin the
// wire format main must produce: a MAC over length-prefixed parts under the
// launch key. Deliberately NOT named *.test.ts: it is imported, never collected.
import { createHmac } from 'node:crypto'

function frame(parts: readonly string[]): Buffer {
  return Buffer.concat(parts.flatMap((part) => {
    const bytes = Buffer.from(part, 'utf8')
    const length = Buffer.alloc(4)
    length.writeUInt32BE(bytes.length)
    return [length, bytes]
  }))
}

export const LAUNCH_KEY = Buffer.alloc(32, 7)

/** The launch key main derives from its safeStorage master key (design §4.3, §14.3). */
export function launchKey(master: Buffer, launchId: string): Buffer {
  return createHmac('sha256', master).update(frame(['agent-inbox/launch-key/v1', launchId])).digest()
}

/** Main's signature over an ask, the revision it was filed at and one option. */
export function sign(key: Buffer, item: string, revision: number, optionId: string): string {
  return createHmac('sha256', key).update(frame(['agent-inbox/launch-approval/v1', item, String(revision), optionId])).digest('hex')
}
