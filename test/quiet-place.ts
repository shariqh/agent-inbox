// test/quiet-place.ts — the place source an in-process buildMcpServer() test passes (#617).
//
// The server reads where its session runs through readers: `tmux` for the desk and the
// host's live file under the home folder for the Remote Control id. A test that builds a
// server in this process must never reach the real ones: run inside tmux, the real desk
// reader starts the developer's own `tmux`, and the other opens a file under the real home.
// These readers touch nothing. test/place-presence.test.ts fails for a buildMcpServer() call
// in a test that does not pass one (`{ place: quietPlace }`).
//
// Deliberately NOT named *.test.ts: it is imported, never collected.
import type { PlaceSource } from '../src/session-place.js'

export const quietPlace: PlaceSource = {
  place: {},
  desk: async () => null,
  remoteSession: () => null,
}
