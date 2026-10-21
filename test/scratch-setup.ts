// test/scratch-setup.ts — Vitest setupFile (#245): after each test FILE, remove
// every scratchDir() it made that an afterEach has not already removed, so no
// suite leaves directories in $TMPDIR. A file whose tests are independent can
// still call removeScratchDirs() from its own afterEach to free space sooner;
// directories made in beforeAll or at module level must wait for this hook.
//
// Deliberately NOT named *.test.ts: it is loaded by vitest.config.ts, never collected.
import { afterAll } from 'vitest'
import { removeScratchDirs } from './scratch.js'

afterAll(removeScratchDirs)
