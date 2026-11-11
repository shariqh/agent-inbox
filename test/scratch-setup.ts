// test/scratch-setup.ts — Vitest setupFile (#245): after each test FILE, detach
// any disk image still attached from a scratchDir() it made (macOS), then remove
// every scratchDir() that an afterEach has not already removed, so no suite
// leaves directories in $TMPDIR or images attached. A file whose tests are independent can
// still call removeScratchDirs() from its own afterEach to free space sooner;
// directories made in beforeAll or at module level must wait for this hook.
//
// Deliberately NOT named *.test.ts: it is loaded by vitest.config.ts, never collected.
import { afterAll } from 'vitest'
import { detachLeftoverImages, removeScratchDirs } from './scratch.js'

// #471: `hdiutil info` (allowed 60 s in scratch.ts) answers in well under a
// second on an idle Mac but can take tens of seconds while other suites build
// and attach images, which overran Vitest's 10 s default and failed whichever
// file was ending. hdiutil's own timeouts bound the work; this one only has to
// outlast them.
const CLEANUP_MS = 180_000

afterAll(() => {
  // A disk image a test left attached from its scratch tree would outlive the
  // directory, unseen by Finder: detach it, and say so, so the leak is fixed
  // in the test rather than piling up on the machine.
  const detached = detachLeftoverImages()
  if (detached.length > 0) {
    console.warn(`[scratch] detached ${detached.length} disk image(s) a test left attached: ${detached.join(', ')}`)
  }
  removeScratchDirs()
}, CLEANUP_MS)
