// writeCardCopy leaves no temporary file behind when the write or the sync throws.
import { afterEach, expect, it, vi } from 'vitest'
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { removeScratchDirs, scratchDir } from './scratch.js'

const sync = vi.hoisted(() => ({ fail: false }))
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, fsyncSync: (fd: number) => { if (sync.fail) throw new Error('sync failed'); return real.fsyncSync(fd) } }
})
import { writeCardCopy } from '../src/mesh-config.js'

afterEach(() => {
  sync.fail = false
  removeScratchDirs()
})

it('removes the temporary file when the sync throws, and writes normally afterwards', () => {
  const dir = scratchDir('mk1f-card-temp-')
  const cards = join(dir, 'mesh', 'cards')
  sync.fail = true
  expect(() => writeCardCopy(dir, 'echo', { name: 'Echo' })).toThrow('sync failed')
  expect(readdirSync(cards)).toEqual([])
  sync.fail = false
  writeCardCopy(dir, 'echo', { name: 'Echo' })
  expect(readdirSync(cards)).toEqual(['echo.json'])
  expect(existsSync(join(cards, 'echo.json'))).toBe(true)
})
