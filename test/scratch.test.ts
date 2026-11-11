// The scratch cleanup's disk-image guard (test/scratch.ts): an image a test
// attaches from its scratch tree and forgets is detached when the file ends,
// mounted or not, so it never outlives the directory unseen by Finder.
import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'

import { attachedImagesUnder, detachLeftoverImages, scratchDir } from './scratch.js'

describe.skipIf(process.platform !== 'darwin')('scratch disk-image guard', () => {
  let dir = ''

  afterAll(() => {
    // never leave this test's own image behind, whatever an assertion did
    if (dir) for (const { device } of attachedImagesUnder(dir)) execFileSync('/usr/bin/hdiutil', ['detach', '-force', device], { stdio: 'ignore' })
  })

  it('detaches an image left attached without a volume, and names it', async () => {
    dir = scratchDir('scratch-image-')
    const source = join(dir, 'source')
    mkdirSync(source)
    writeFileSync(join(source, 'file'), 'x')
    const image = join(dir, 'left.dmg')
    const create = () => execFileSync('/usr/bin/hdiutil', ['create', '-srcfolder', source, '-format', 'UDZO', image], { stdio: ['ignore', 'ignore', 'pipe'], timeout: 120_000 })
    // #471: while test/macos-dmg.test.ts builds images in parallel, hdiutil can
    // refuse this one (`create failed - Resource busy`). Building the fixture is
    // not what this test checks, so it gets the one retry macos-dmg's builds get.
    try {
      create()
    } catch (error) {
      console.warn(`hdiutil create failed, retrying once: ${String((error as { stderr?: Buffer }).stderr ?? error).trim()}`)
      rmSync(image, { force: true })
      await new Promise((resolve) => setTimeout(resolve, 5_000))
      create()
    }
    execFileSync('/usr/bin/hdiutil', ['attach', '-nomount', '-noautoopen', image], { stdio: 'ignore', timeout: 120_000 })
    expect(attachedImagesUnder(dir)).toHaveLength(1)

    const detached = detachLeftoverImages()
    expect(detached).toHaveLength(1)
    expect(detached[0]!.endsWith('/left.dmg')).toBe(true)
    expect(attachedImagesUnder(dir)).toEqual([])
  }, 300_000)
})
