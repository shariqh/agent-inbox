import { execFileSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, realpathSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import links from '../electron/link-open.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { blockedFileName, externalWebUrl, fileOpenPlan, isTrustedLinkSender, isViewerUrl, normalizeLocalPath, openLinkRequest, openWebLink } = links

const VIEWER = 'http://127.0.0.1:4319/'
const ON_MAC = process.platform === 'darwin' && existsSync('/usr/bin/xattr')
// What a modern Finder alias starts with (a bookmark file), then some payload.
const BOOKMARK = Buffer.concat([Buffer.from('book\0\0\0\0mark\0\0\0\0', 'latin1'), Buffer.alloc(48, 7)])

// /usr/bin/xattr as main calls it, answered by `answer` for each argv.
function fakeXattr(answer: (args: string[]) => string | Error = () => '') {
  const calls: Array<{ file: string; args: string[] }> = []
  const execFileImpl = (file: string, args: string[], _options: object, callback: (error: Error | null, stdout: string) => void) => {
    calls.push({ file, args })
    const result = answer(args)
    setTimeout(() => (result instanceof Error ? callback(result, '') : callback(null, result)), 0)
  }
  return { calls, execFileImpl }
}

// The 32-byte com.apple.FinderInfo value, as `xattr -px` prints it.
function finderInfoHex(flags: number, type = '\0\0\0\0') {
  const bytes = Buffer.alloc(32)
  bytes.write(type, 0, 'latin1')
  bytes.writeUInt16BE(flags, 8)
  return `${[...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ')}\n`
}

afterEach(() => removeScratchDirs())

describe('web links: http and https only (issue #300)', () => {
  it.each([
    ['https://example.com/a?b=c#d', 'https://example.com/a?b=c#d'],
    ['http://localhost:3000/x', 'http://localhost:3000/x'],
    ['HTTPS://Example.COM/A', 'https://example.com/A'],
  ])('accepts %s as its normalized href', (url, href) => {
    expect(externalWebUrl(url)).toBe(href)
  })

  it.each([
    'javascript:alert(1)',
    'JaVaScRiPt:alert(1)',
    'file:///etc/passwd',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'mailto:a@example.com',
    'ssh://host',
    'smb://share/x',
    'x-apple.systempreferences:com.apple.preference.security',
    'vscode://file/Users/s/a.md',
    '//example.com/x',
    '/Users/s/a.md',
    'https://',
    '',
    `https://example.com/${'a'.repeat(9000)}`,
    42,
    null,
  ])('refuses %j', (url) => {
    expect(externalWebUrl(url)).toBeNull()
  })

  it('tells the viewer’s own pages from everything else by origin', () => {
    expect(isViewerUrl('http://127.0.0.1:4319/', VIEWER)).toBe(true)
    expect(isViewerUrl('http://127.0.0.1:4319/#item=x', VIEWER)).toBe(true)
    expect(isViewerUrl('http://127.0.0.1:4320/', VIEWER)).toBe(false)
    expect(isViewerUrl('http://127.0.0.1:4319@evil.example/', VIEWER)).toBe(false)
    expect(isViewerUrl('http://localhost:4319/', VIEWER)).toBe(false)
    expect(isViewerUrl('not a url', VIEWER)).toBe(false)
  })

  it('opens only a checked href, and never lets a rejection escape', async () => {
    const opened: string[] = []
    const shell = { openExternal: async (url: string) => { opened.push(url); throw new Error('no browser') } }
    expect(openWebLink('javascript:alert(1)', shell)).toBe(false)
    expect(openWebLink('file:///Users/s/a.md', shell)).toBe(false)
    expect(openWebLink('https://example.com/x', shell)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(opened).toEqual(['https://example.com/x'])
  })
})

describe('local paths (issue #300)', () => {
  it('expands ~/, normalizes, and refuses anything that is not a plain absolute path', () => {
    expect(normalizeLocalPath('~/a/../b.md', '/Users/s')).toBe('/Users/s/b.md')
    expect(normalizeLocalPath('/Users/s//x/./y.md', '/Users/s')).toBe('/Users/s/x/y.md')
    for (const bad of ['relative/a.md', '~', '~other/x', '/Users/s/a\u0000.md', '/Users/s/a\n.md', '/Users/s/\u001b[0m', '', `/${'a'.repeat(5000)}`, 7, null]) {
      expect(normalizeLocalPath(bad, '/Users/s'), String(bad)).toBeNull()
    }
    expect(normalizeLocalPath('~/a.md', 'relative-home')).toBeNull()
  })

  it.each([
    'Evil.app', 'run.command', 'tool.TOOL', 'x.terminal', 'a.pkg', 'a.mpkg', 'a.dmg', 'a.jar',
    'a.scpt', 'a.workflow', 'a.prefPane', 'a.webloc', 'a.inetloc', 'a.fileloc', 'a.mobileconfig', 'a.desktop',
    'a.AppImage', 'a.deb', 'a.exe', 'a.bat', 'a.cmd', 'a.docm', 'a.vsix', 'a.cer',
    // disk images
    'a.cdr', 'a.toast', 'a.dvdr', 'a.udif', 'a.dmgpart', 'a.asif',
    // Office files that can carry macros
    'a.xlsb', 'a.xla', 'a.ppa', 'a.dot', 'a.xlt', 'a.pot', 'a.pps', 'a.slk', 'a.doc', 'a.xls', 'a.ppt',
    // files that mount, connect or run something else
    'a.afploc', 'a.smbloc', 'a.ovpn', 'a.shortcut',
  ])('treats %s as never openable', (name) => {
    expect(blockedFileName(`/Users/s/${name}`)).toBe(true)
  })

  // Not denied, so Settings → Links can name an app for them; code files are
  // not opened by default either (see the allow-list below).
  it.each(['a.md', 'a.markdown', 'a.txt', 'a.pdf', 'a.png', 'a.json', 'a.html', 'a.py', 'a.sh', 'a.rb', 'a.ts', 'a.js', 'a.docx', '.zshrc', 'Makefile', 'a.app.md'])(
    'does not deny %s', (name) => {
      expect(blockedFileName(`/Users/s/${name}`)).toBe(false)
    },
  )
})

describe('fileOpenPlan judges the final target (issue #300)', () => {
  function tree() {
    const root = scratchDir('link-open-')
    const file = (name: string, mode = 0o644) => {
      const path = join(root, name)
      writeFileSync(path, 'x')
      chmodSync(path, mode)
      return path
    }
    mkdirSync(join(root, 'folder'))
    mkdirSync(join(root, 'Tool.app'))
    const doc = file('doc.md')
    const script = file('run.command')
    const binary = file('binary', 0o755)
    const groupExec = file('notes.txt', 0o650)
    symlinkSync(doc, join(root, 'doc-link.md'))
    symlinkSync(script, join(root, 'innocent.md'))
    symlinkSync(binary, join(root, 'also-innocent.md'))
    symlinkSync(doc, join(root, 'launcher.command'))
    symlinkSync(join(root, 'Tool.app'), join(root, 'app-link'))
    symlinkSync(join(root, 'gone.md'), join(root, 'dangling.md'))
    return { root, doc, groupExec }
  }

  it('opens a plain document, resolved', async () => {
    const { root, doc } = tree()
    expect(await fileOpenPlan(join(root, 'doc.md'), { homeDir: root })).toMatchObject({ ok: true, action: 'open' })
    const viaLink = await fileOpenPlan(join(root, 'doc-link.md'), { homeDir: root })
    expect(viaLink).toMatchObject({ ok: true, action: 'open' })
    expect(viaLink.ok && viaLink.path.endsWith('/doc.md')).toBe(true)
    expect(await fileOpenPlan('~/doc.md', { homeDir: root })).toMatchObject({ ok: true, action: 'open' })
    expect(doc).toBeTruthy()
  })

  it.each([
    ['folder', 'folder'],
    ['Tool.app', 'app'],
    ['app-link', 'app'],
    ['run.command', 'blocked'],
    ['innocent.md', 'blocked'],
    ['launcher.command', 'blocked'],
    ['binary', 'executable'],
    ['also-innocent.md', 'executable'],
    ['notes.txt', 'executable'],
  ])('only reveals %s (%s)', async (name, reason) => {
    const { root } = tree()
    expect(await fileOpenPlan(join(root, name), { homeDir: root })).toMatchObject({ ok: true, action: 'reveal', reason })
  })

  it('reports a missing file, a dangling link and a bad path without touching anything', async () => {
    const { root } = tree()
    expect(await fileOpenPlan(join(root, 'nope.md'), { homeDir: root })).toEqual({ ok: false, reason: 'missing' })
    expect(await fileOpenPlan(join(root, 'dangling.md'), { homeDir: root })).toEqual({ ok: false, reason: 'missing' })
    expect(await fileOpenPlan(join(root, 'doc.md', 'below'), { homeDir: root })).toEqual({ ok: false, reason: 'missing' })
    expect(await fileOpenPlan('relative.md', { homeDir: root })).toEqual({ ok: false, reason: 'invalid' })
  })
})

describe('fileOpenPlan opens only common document types itself (issue #300)', () => {
  const OPENABLE = [
    'md', 'markdown', 'txt', 'text', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'xml', 'pdf',
    'png', 'jpg', 'jpeg', 'gif', 'webp', 'heic', 'svg', 'html', 'htm', 'diff', 'patch', 'mov', 'mp4',
  ]
  const write = (root: string, name: string) => {
    const file = join(root, name)
    writeFileSync(file, 'x')
    return file
  }

  it('opens each allow-listed type, whatever its case', async () => {
    const root = scratchDir('link-allow-')
    const { execFileImpl } = fakeXattr()
    for (const name of [...OPENABLE.map((ext) => `a.${ext}`), 'B.PDF', 'c.Md']) {
      expect(await fileOpenPlan(write(root, name), { homeDir: root, platform: 'darwin', execFileImpl }), name)
        .toEqual({ ok: true, action: 'open', path: realpathSync(join(root, name)) })
    }
  })

  it.each(['a.py', 'a.rb', 'a.pl', 'a.php', 'a.sh', 'a.zsh', 'a.js', 'a.ts', 'a.applescript', 'a.docx', 'a.rtf', 'a.zip', 'a.xyz', 'README', '.zshrc', 'a.md.bak'])(
    'only reveals %s, a type it does not open, without reading its attributes',
    async (name) => {
      const root = scratchDir('link-unlisted-')
      const { calls, execFileImpl } = fakeXattr()
      const file = write(root, name)
      expect(await fileOpenPlan(file, { homeDir: root, platform: 'darwin', execFileImpl }))
        .toEqual({ ok: true, action: 'reveal', path: realpathSync(file), reason: 'type' })
      expect(calls).toEqual([])
    },
  )

  it.each(['a.cdr', 'a.toast', 'a.xlsb', 'a.doc', 'a.afploc', 'a.smbloc', 'a.ovpn'])('only reveals %s as never opened', async (name) => {
    const root = scratchDir('link-denied-')
    const file = write(root, name)
    expect(await fileOpenPlan(file, { homeDir: root, platform: 'darwin', execFileImpl: fakeXattr().execFileImpl }))
      .toEqual({ ok: true, action: 'reveal', path: realpathSync(file), reason: 'blocked' })
  })

  it('judges the type of the final target, not the name of the link', async () => {
    const root = scratchDir('link-target-type-')
    const { execFileImpl } = fakeXattr()
    symlinkSync(write(root, 'payload.rtf'), join(root, 'report.md'))
    symlinkSync(write(root, 'doc.md'), join(root, 'latest'))
    expect(await fileOpenPlan(join(root, 'report.md'), { homeDir: root, platform: 'darwin', execFileImpl }))
      .toMatchObject({ ok: true, action: 'reveal', reason: 'type' })
    expect(await fileOpenPlan(join(root, 'latest'), { homeDir: root, platform: 'darwin', execFileImpl }))
      .toEqual({ ok: true, action: 'open', path: realpathSync(join(root, 'doc.md')) })
  })
})

describe('fileOpenPlan reveals an alias or an Open With file, whatever its type (issue #300)', () => {
  const doc = (name = 'notes.md', bytes: string | Buffer = '# notes\n') => {
    const root = scratchDir('link-alias-')
    const file = join(root, name)
    writeFileSync(file, bytes)
    return { root, file, real: realpathSync(file) }
  }

  it('reveals a bookmark-format alias named like a document, before asking xattr', async () => {
    const { root, file, real } = doc('notes.md', BOOKMARK)
    const { calls, execFileImpl } = fakeXattr()
    expect(await fileOpenPlan(file, { homeDir: root, platform: 'darwin', execFileImpl }))
      .toEqual({ ok: true, action: 'reveal', path: real, reason: 'blocked' })
    expect(calls).toEqual([])
  })

  it.each([
    ['the bookmark header one byte in', Buffer.concat([Buffer.from('#'), BOOKMARK])],
    ['the bookmark header later in the file', Buffer.concat([Buffer.from('# notes\n'), BOOKMARK])],
    ['a file that starts like one', Buffer.from('bookkeeping\0mark')],
    ['a file shorter than the header', Buffer.from('book')],
    ['an empty file', Buffer.alloc(0)],
  ])('opens %s', async (_name, bytes) => {
    const { root, file, real } = doc('notes.md', bytes)
    expect(await fileOpenPlan(file, { homeDir: root, platform: 'darwin', execFileImpl: fakeXattr().execFileImpl }))
      .toEqual({ ok: true, action: 'open', path: real })
  })

  it('lists the attributes of the resolved file with argv only, and opens a file with none that matter', async () => {
    const { root, file, real } = doc()
    const { calls, execFileImpl } = fakeXattr(() => 'com.apple.provenance\ncom.apple.quarantine\ncom.apple.metadata:kMDItemWhereFroms\n')
    symlinkSync(file, join(root, 'link.md'))
    expect(await fileOpenPlan(join(root, 'link.md'), { homeDir: root, platform: 'darwin', execFileImpl }))
      .toEqual({ ok: true, action: 'open', path: real })
    expect(calls).toEqual([{ file: '/usr/bin/xattr', args: [real] }])
  })

  it.each([
    'com.apple.LaunchServices.OpenWith',
    'com.apple.LaunchServices.OpenWith#PS',
  ])('reveals a file carrying %s, whatever its value', async (name) => {
    const { root, file, real } = doc()
    const { calls, execFileImpl } = fakeXattr(() => `com.apple.provenance\n${name}\n`)
    expect(await fileOpenPlan(file, { homeDir: root, platform: 'darwin', execFileImpl }))
      .toEqual({ ok: true, action: 'reveal', path: real, reason: 'blocked' })
    expect(calls).toHaveLength(1)
  })

  it('reads the Finder alias flag from com.apple.FinderInfo', async () => {
    const { root, file, real } = doc()
    const answer = (flags: number) => (args: string[]) => (args[0] === '-px' ? finderInfoHex(flags, 'alis') : 'com.apple.FinderInfo\n')
    const alias = fakeXattr(answer(0x8000))
    expect(await fileOpenPlan(file, { homeDir: root, platform: 'darwin', execFileImpl: alias.execFileImpl }))
      .toEqual({ ok: true, action: 'reveal', path: real, reason: 'blocked' })
    expect(alias.calls).toEqual([
      { file: '/usr/bin/xattr', args: [real] },
      { file: '/usr/bin/xattr', args: ['-px', 'com.apple.FinderInfo', real] },
    ])
    for (const flags of [0x0000, 0x4000, 0x0100]) {
      expect(await fileOpenPlan(file, { homeDir: root, platform: 'darwin', execFileImpl: fakeXattr(answer(flags)).execFileImpl }), String(flags))
        .toEqual({ ok: true, action: 'open', path: real })
    }
  })

  it.each([
    ['the attributes cannot be listed', () => new Error('xattr: [Errno 1] Operation not permitted')],
    ['the Finder info cannot be read', (args: string[]) => (args[0] === '-px' ? new Error('No such xattr') : 'com.apple.FinderInfo\n')],
    ['the Finder info is not hex', (args: string[]) => (args[0] === '-px' ? 'not hex at all\n' : 'com.apple.FinderInfo\n')],
    ['the Finder info ends in something else', (args: string[]) => (args[0] === '-px' ? `${finderInfoHex(0).trim()} zz\n` : 'com.apple.FinderInfo\n')],
    ['the Finder info is too short', (args: string[]) => (args[0] === '-px' ? '00 00 00 00 00 00 00 00 80\n' : 'com.apple.FinderInfo\n')],
  ])('reveals a document when %s', async (_name, answer) => {
    const { root, file, real } = doc()
    expect(await fileOpenPlan(file, { homeDir: root, platform: 'darwin', execFileImpl: fakeXattr(answer).execFileImpl }))
      .toEqual({ ok: true, action: 'reveal', path: real, reason: 'blocked' })
  })

  it('reveals a document when xattr cannot even start', async () => {
    const { root, file, real } = doc()
    const execFileImpl = () => { throw new Error('spawn EAGAIN') }
    expect(await fileOpenPlan(file, { homeDir: root, platform: 'darwin', execFileImpl }))
      .toEqual({ ok: true, action: 'reveal', path: real, reason: 'blocked' })
  })

  it.skipIf(process.getuid?.() === 0)('reveals a document it cannot read', async () => {
    const { root, file, real } = doc()
    chmodSync(file, 0o000)
    try {
      expect(await fileOpenPlan(file, { homeDir: root, platform: 'darwin', execFileImpl: fakeXattr().execFileImpl }))
        .toEqual({ ok: true, action: 'reveal', path: real, reason: 'blocked' })
    } finally {
      chmodSync(file, 0o644)
    }
  })

  it('checks none of this where there is no Launch Services', async () => {
    const { root, file, real } = doc('notes.md', BOOKMARK)
    const { calls, execFileImpl } = fakeXattr(() => 'com.apple.LaunchServices.OpenWith\n')
    expect(await fileOpenPlan(file, { homeDir: root, platform: 'linux', execFileImpl }))
      .toEqual({ ok: true, action: 'open', path: real })
    expect(calls).toEqual([])
  })
})

describe.runIf(ON_MAC)('real aliases and attributes on macOS (issue #300)', () => {
  const xattr = (...args: string[]) => execFileSync('/usr/bin/xattr', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  const finderInfo = (flags: number, type = '\0\0\0\0') => finderInfoHex(flags, type).trim()
  const doc = () => {
    const root = scratchDir('link-mac-')
    const file = join(root, 'notes.md')
    writeFileSync(file, '# notes\n')
    return { root, file, real: realpathSync(file) }
  }
  const plan = (file: string, root: string) => fileOpenPlan(file, { homeDir: root })

  it('reveals a real Finder alias named notes.md that points at a script', async () => {
    const root = scratchDir('link-mac-alias-')
    const script = join(root, 'evil.command')
    writeFileSync(script, '#!/bin/sh\necho owned\n')
    chmodSync(script, 0o755)
    const alias = join(root, 'notes.md')
    execFileSync('/usr/bin/osascript', ['-l', 'JavaScript', '-e', `ObjC.import('Foundation')
      function run(argv) {
        const kind = $.NSURLBookmarkCreationSuitableForBookmarkFile
        const data = $.NSURL.fileURLWithPath(argv[0]).bookmarkDataWithOptionsIncludingResourceValuesForKeysRelativeToURLError(kind, $(), $(), null)
        if (!$.NSURL.writeBookmarkDataToURLOptionsError(data, $.NSURL.fileURLWithPath(argv[1]), kind, null)) throw new Error('no alias')
      }`, script, alias], { stdio: 'ignore' })
    expect(await plan(alias, root)).toEqual({ ok: true, action: 'reveal', path: realpathSync(alias), reason: 'blocked' })
  })

  it('reveals a file whose Finder info marks it as an alias, and opens one whose Finder info does not', async () => {
    const flagged = doc()
    xattr('-wx', 'com.apple.FinderInfo', finderInfo(0x8000, 'alis'), flagged.file)
    expect(await plan(flagged.file, flagged.root)).toEqual({ ok: true, action: 'reveal', path: flagged.real, reason: 'blocked' })
    const plain = doc()
    xattr('-wx', 'com.apple.FinderInfo', finderInfo(0x0000, 'TEXT'), plain.file)
    xattr('-w', 'com.apple.quarantine', '0081;00000000;Safari;', plain.file)
    expect(await plan(plain.file, plain.root)).toEqual({ ok: true, action: 'open', path: plain.real })
  })

  it('reveals a file with a per-file Open With', async () => {
    const { root, file, real } = doc()
    xattr('-w', 'com.apple.LaunchServices.OpenWith', 'Terminal', file)
    expect(await plan(file, root)).toEqual({ ok: true, action: 'reveal', path: real, reason: 'blocked' })
  })

  it('reveals a file with a resource fork', async () => {
    const { root, file, real } = doc()
    writeFileSync(join(file, '..namedfork', 'rsrc'), 'alis')
    expect(await plan(file, root)).toEqual({ ok: true, action: 'reveal', path: real, reason: 'blocked' })
  })
})

describe('openLinkRequest (issue #300)', () => {
  function fakeShell() {
    const calls: Array<[string, string]> = []
    return {
      calls,
      shell: {
        openExternal: async (url: string) => { calls.push(['openExternal', url]) },
        openPath: async (path: string) => { calls.push(['openPath', path]); return '' },
        showItemInFolder: (path: string) => { calls.push(['showItemInFolder', path]) },
      },
    }
  }

  it('sends a checked web link to the browser and refuses any other scheme', async () => {
    const { calls, shell } = fakeShell()
    expect(await openLinkRequest({ kind: 'web', url: 'https://example.com/x' }, { shell, homeDir: '/Users/s' })).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'web', url: 'file:///etc/passwd' }, { shell, homeDir: '/Users/s' })).toEqual({ ok: false, reason: 'invalid' })
    expect(calls).toEqual([['openExternal', 'https://example.com/x']])
  })

  it('opens a document, and only reveals a script or a type it does not open', async () => {
    const root = scratchDir('link-open-req-')
    writeFileSync(join(root, 'a.md'), 'x')
    writeFileSync(join(root, 'a.command'), 'x')
    writeFileSync(join(root, 'a.py'), 'x')
    const { calls, shell } = fakeShell()
    const deps = { shell, homeDir: root, platform: 'darwin', execFileImpl: fakeXattr().execFileImpl }
    expect(await openLinkRequest({ kind: 'file', path: '~/a.md' }, deps)).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.command') }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.py') }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'type' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'missing.md') }, deps)).toEqual({ ok: false, reason: 'missing' })
    expect(calls.map(([call]) => call)).toEqual(['openPath', 'showItemInFolder', 'showItemInFolder'])
    expect(calls.every(([, path]) => !path.includes('~'))).toBe(true)
  })

  it('reveals an alias it was asked to open', async () => {
    const root = scratchDir('link-open-alias-')
    writeFileSync(join(root, 'notes.md'), BOOKMARK)
    const { calls, shell } = fakeShell()
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'notes.md') }, { shell, homeDir: root, platform: 'darwin', execFileImpl: fakeXattr().execFileImpl }))
      .toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
    expect(calls).toEqual([['showItemInFolder', realpathSync(join(root, 'notes.md'))]])
  })

  it.each([
    null,
    'https://example.com',
    [],
    { kind: 'web' },
    { kind: 'web', url: 'https://example.com', extra: 1 },
    { kind: 'file' },
    { kind: 'file', path: '/Users/s/a.md', reveal: false },
    { kind: 'file', path: '/Users/s/a.md', reveal: true },
    { kind: 'file', path: 42 },
    { kind: 'app', path: '/Applications/X.app' },
  ])('refuses the malformed request %j', async (request) => {
    const { calls, shell } = fakeShell()
    expect(await openLinkRequest(request, { shell, homeDir: '/Users/s' })).toEqual({ ok: false, reason: 'invalid' })
    expect(calls).toEqual([])
  })

  it('reports a failed open instead of throwing', async () => {
    const root = scratchDir('link-open-fail-')
    writeFileSync(join(root, 'a.md'), 'x')
    writeFileSync(join(root, 'a.py'), 'x')
    const shell = {
      openExternal: async () => { throw new Error('nope') },
      openPath: async () => 'no app for this',
      showItemInFolder: () => { throw new Error('nope') },
    }
    const deps = { shell, homeDir: root, platform: 'darwin', execFileImpl: fakeXattr().execFileImpl }
    expect(await openLinkRequest({ kind: 'web', url: 'https://example.com' }, deps)).toEqual({ ok: false, reason: 'failed' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.md') }, deps)).toEqual({ ok: false, reason: 'failed' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.py') }, deps)).toEqual({ ok: false, reason: 'failed' })
  })
})

describe('isTrustedLinkSender (issue #300)', () => {
  function windowWith(contents: object, { destroyed = false, contentsDestroyed = false } = {}) {
    return {
      isDestroyed: () => destroyed,
      webContents: Object.assign(contents, { isDestroyed: () => contentsDestroyed }),
    }
  }
  const mainFrame = (url: string) => ({ url, parent: null })

  it('accepts only the viewer window’s own top frame on the viewer origin', () => {
    const contents = {}
    const window = windowWith(contents)
    const ok = { sender: contents, senderFrame: mainFrame('http://127.0.0.1:4319/#x'), window, viewerUrl: VIEWER }
    expect(isTrustedLinkSender(ok)).toBe(true)
    expect(isTrustedLinkSender({ ...ok, sender: {} })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, senderFrame: mainFrame('https://evil.example/') })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, senderFrame: mainFrame('http://127.0.0.1:4320/') })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, senderFrame: { url: 'http://127.0.0.1:4319/', parent: {} } })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, senderFrame: null })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, window: null })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, window: windowWith(contents, { destroyed: true }) })).toBe(false)
    expect(isTrustedLinkSender({ ...ok, window: windowWith(contents, { contentsDestroyed: true }) })).toBe(false)
  })

  it('treats a frame Electron has already disposed as untrusted', () => {
    const contents = {}
    const senderFrame = { get url(): string { throw new Error('Render frame was disposed') }, parent: null }
    expect(isTrustedLinkSender({ sender: contents, senderFrame, window: windowWith(contents), viewerUrl: VIEWER })).toBe(false)
  })
})
