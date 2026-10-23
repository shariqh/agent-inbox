import { execFileSync } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { chmodSync, existsSync, mkdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import links from '../electron/link-open.cjs'
import type { LinkRules } from '../electron/link-open.cjs'
import preferences from '../electron/link-preferences.cjs'
import { removeScratchDirs, scratchDir } from './scratch.js'

const { blockedFileName, externalWebUrl, fileOpenPlan, isTrustedLinkSender, isViewerUrl, joinRepoPath, normalizeLocalPath, openLinkRequest, openWebLink } = links

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
    'md', 'markdown', 'txt', 'text', 'log', 'json', 'jsonl', 'yaml', 'yml', 'toml', 'csv', 'tsv', 'pdf',
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

  // XML among them: Office's handler on Windows sends a .xml that names Word in
  // its processing instruction to Word, and Word 2003 XML can carry macros.
  it.each(['a.py', 'a.rb', 'a.pl', 'a.php', 'a.sh', 'a.zsh', 'a.js', 'a.ts', 'a.applescript', 'a.docx', 'a.rtf', 'a.xml', 'B.XML', 'a.zip', 'a.xyz', 'README', '.zshrc', 'a.md.bak'])(
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

  it('only reveals Word 2003 XML, which Office would hand to Word, as it does any XML', async () => {
    const root = scratchDir('link-word-xml-')
    const { calls, execFileImpl } = fakeXattr()
    const file = join(root, 'report.xml')
    writeFileSync(file, '<?xml version="1.0"?>\n<?mso-application progid="Word.Document"?>\n<w:wordDocument/>\n')
    expect(await fileOpenPlan(file, { homeDir: root, platform: 'win32', execFileImpl }))
      .toEqual({ ok: true, action: 'reveal', path: realpathSync(file), reason: 'type' })
    expect(calls).toEqual([])
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

  it('opens a document, only reveals a script or a type it does not open, and reveals on request', async () => {
    const root = scratchDir('link-open-req-')
    writeFileSync(join(root, 'a.md'), 'x')
    writeFileSync(join(root, 'a.command'), 'x')
    writeFileSync(join(root, 'a.py'), 'x')
    const { calls, shell } = fakeShell()
    const deps = { shell, homeDir: root, platform: 'darwin', execFileImpl: fakeXattr().execFileImpl, filesPermitted: true }
    expect(await openLinkRequest({ kind: 'file', path: '~/a.md', reveal: false }, deps)).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.command'), reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.py'), reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'type' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.md'), reveal: true }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'requested' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'missing.md'), reveal: true }, deps)).toEqual({ ok: false, reason: 'missing' })
    expect(calls.map(([call]) => call)).toEqual(['openPath', 'showItemInFolder', 'showItemInFolder', 'showItemInFolder'])
    expect(calls.every(([, path]) => !path.includes('~'))).toBe(true)
  })

  it('reveals an alias it was asked to open', async () => {
    const root = scratchDir('link-open-alias-')
    writeFileSync(join(root, 'notes.md'), BOOKMARK)
    const { calls, shell } = fakeShell()
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'notes.md'), reveal: false }, { shell, homeDir: root, platform: 'darwin', execFileImpl: fakeXattr().execFileImpl, filesPermitted: true }))
      .toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
    expect(calls).toEqual([['showItemInFolder', realpathSync(join(root, 'notes.md'))]])
  })

  it('opens files only for the viewer this app owns, and web links anywhere', async () => {
    const root = scratchDir('link-open-unowned-')
    writeFileSync(join(root, 'a.md'), 'x')
    // nothing about the path is even looked at
    const touched: string[] = []
    const untouched = new Proxy({}, { get(_target, name) { touched.push(String(name)); throw new Error('the filesystem was read') } })
    const execFileImpl = () => { touched.push('xattr'); throw new Error('xattr ran') }
    for (const filesPermitted of [false, undefined, 'yes', 1]) {
      const { calls, shell } = fakeShell()
      const deps = { shell, homeDir: root, fsp: untouched, platform: 'darwin', execFileImpl, filesPermitted } as never
      expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.md'), reveal: false }, deps), String(filesPermitted)).toEqual({ ok: false, reason: 'unowned' })
      expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.md'), reveal: true }, deps)).toEqual({ ok: false, reason: 'unowned' })
      expect(await openLinkRequest({ kind: 'file', path: '/nowhere/at/all.md', reveal: false }, deps)).toEqual({ ok: false, reason: 'unowned' })
      expect(await openLinkRequest({ kind: 'web', url: 'https://example.com/pr/1' }, deps)).toEqual({ ok: true, action: 'opened' })
      expect(calls).toEqual([['openExternal', 'https://example.com/pr/1']])
    }
    expect(touched).toEqual([])
    const { calls, shell } = fakeShell()
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.md'), reveal: false }, {
      shell, homeDir: root, platform: 'darwin', execFileImpl: fakeXattr().execFileImpl, filesPermitted: true,
    })).toEqual({ ok: true, action: 'opened' })
    expect(calls).toEqual([['openPath', realpathSync(join(root, 'a.md'))]])
  })

  it.each([
    null,
    'https://example.com',
    [],
    { kind: 'web' },
    { kind: 'web', url: 'https://example.com', extra: 1 },
    { kind: 'file' },
    { kind: 'file', path: '/Users/s/a.md' },
    { kind: 'file', path: '/Users/s/a.md', reveal: 'yes' },
    { kind: 'file', path: 42, reveal: false },
    { kind: 'app', path: '/Applications/X.app', reveal: false },
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
    const deps = { shell, homeDir: root, platform: 'darwin', execFileImpl: fakeXattr().execFileImpl, filesPermitted: true }
    expect(await openLinkRequest({ kind: 'web', url: 'https://example.com' }, deps)).toEqual({ ok: false, reason: 'failed' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.md'), reveal: false }, deps)).toEqual({ ok: false, reason: 'failed' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.py'), reveal: false }, deps)).toEqual({ ok: false, reason: 'failed' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'a.md'), reveal: true }, deps)).toEqual({ ok: false, reason: 'failed' })
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

describe('Settings → Links rules, applied after the safety policy (issue #300 part 2)', () => {
  const SPAWN_OPTIONS = { stdio: 'ignore', shell: false, detached: true, windowsHide: true }
  // a file with no attributes, so these run the same on every OS
  const noXattr = fakeXattr().execFileImpl

  // A spawn that records argv and options and answers as a real child would.
  function fakeSpawn({ exitCode = 0, fail = false }: { exitCode?: number, fail?: boolean } = {}) {
    const calls: Array<{ command: string, args: string[], options: unknown }> = []
    const spawnImpl = (command: string, args: string[], options: unknown) => {
      calls.push({ command, args, options })
      const child = Object.assign(new EventEmitter(), { unref: () => {} })
      queueMicrotask(() => {
        if (fail) child.emit('error', new Error('spawn ENOENT'))
        else {
          child.emit('spawn')
          child.emit('exit', exitCode)
        }
      })
      return child
    }
    return { calls, spawnImpl }
  }

  function recordingShell() {
    const calls: Array<[string, string]> = []
    return {
      calls,
      shell: {
        openExternal: async (url: string) => { calls.push(['openExternal', url]) },
        openPath: async (target: string) => { calls.push(['openPath', target]); return '' },
        showItemInFolder: (target: string) => { calls.push(['showItemInFolder', target]) },
      },
    }
  }

  function files() {
    const root = scratchDir('link-rules-')
    const file = (name: string, mode = 0o644) => {
      writeFileSync(join(root, name), 'x')
      chmodSync(join(root, name), mode)
      return realpathSync(join(root, name))
    }
    mkdirSync(join(root, 'docs.md'))
    const app = bundle(root, 'QLMarkdown')
    writeFileSync(join(root, 'alias.md'), BOOKMARK)
    return {
      root, app, realApp: realpathSync(app),
      doc: file('notes.md'), log: file('run.log'), script: file('run.command'), tool: file('tool.md', 0o755),
      code: file('build.py'), shell: file('deploy.sh'), notes: file('notes.rtf'), alias: realpathSync(join(root, 'alias.md')),
    }
  }

  // An .app bundle as the native picker would have accepted it.
  function bundle(root: string, name: string): string {
    const app = join(root, `${name}.app`)
    mkdirSync(join(app, 'Contents'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>')
    return app
  }

  const rules = (over: Record<string, unknown> = {}) =>
    ({ web: { handler: 'default' }, markdown: { handler: 'default' }, types: [], ...over }) as unknown as LinkRules

  it('opens Markdown in the app chosen in main’s picker, argv only: open -a <app> -- <file>', async () => {
    const { root, app, realApp, doc } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    const result = await openLinkRequest({ kind: 'file', path: doc, reveal: false }, {
      shell, homeDir: root, filesPermitted: true, rules: rules({ markdown: { handler: 'app', app } }), platform: 'darwin', execFileImpl: noXattr, spawnImpl,
    })
    expect(result).toEqual({ ok: true, action: 'opened' })
    expect(calls).toEqual([{ command: '/usr/bin/open', args: ['-a', realApp, '--', doc], options: SPAWN_OPTIONS }])
    expect(shellCalls).toEqual([])
  })

  it('previews with Quick Look, reveals by rule, and follows an added type', async () => {
    const { root, doc, log } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    const deps = { shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, spawnImpl, rules: rules({ markdown: { handler: 'quicklook' }, types: [{ extension: 'log', handler: 'reveal' }] }) }
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, deps)).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'file', path: log, reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'rule' })
    expect(calls).toEqual([{ command: '/usr/bin/qlmanage', args: ['-p', doc], options: SPAWN_OPTIONS }])
    expect(shellCalls).toEqual([['showItemInFolder', log]])
  })

  it('never lets a rule open what the policy only reveals', async () => {
    const { root, app, script, tool, alias, doc } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    const openWith = fakeXattr(() => 'com.apple.LaunchServices.OpenWith\n').execFileImpl
    for (const handler of [{ handler: 'app', app }, { handler: 'quicklook' }]) {
      const deps = {
        shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, spawnImpl,
        rules: rules({ markdown: handler, types: [{ extension: 'command', ...handler }] }),
      }
      expect(await openLinkRequest({ kind: 'file', path: script, reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
      expect(await openLinkRequest({ kind: 'file', path: tool, reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'executable' })
      expect(await openLinkRequest({ kind: 'file', path: join(root, 'docs.md'), reveal: false }, deps)).toMatchObject({ ok: true, action: 'revealed', reason: 'folder' })
      expect(await openLinkRequest({ kind: 'file', path: alias, reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
      expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, { ...deps, execFileImpl: openWith })).toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
    }
    expect(calls).toEqual([])
    expect(shellCalls.map(([call]) => call)).toEqual(Array(10).fill('showItemInFolder'))
  })

  it('lets an app or Quick Look rule open a type the system default may not, and never System default', async () => {
    const { root, app, realApp, code, shell: script, notes } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    const deps = {
      shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, spawnImpl,
      rules: rules({ types: [{ extension: 'py', handler: 'app', app }, { extension: 'sh', handler: 'quicklook' }, { extension: 'rtf', handler: 'default' }] }),
    }
    expect(await openLinkRequest({ kind: 'file', path: code, reveal: false }, deps)).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'file', path: script, reveal: false }, deps)).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'file', path: notes, reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'type' })
    expect(calls).toEqual([
      { command: '/usr/bin/open', args: ['-a', realApp, '--', code], options: SPAWN_OPTIONS },
      { command: '/usr/bin/qlmanage', args: ['-p', script], options: SPAWN_OPTIONS },
    ])
    expect(shellCalls).toEqual([['showItemInFolder', notes]])
    // the same files, with no rule or off macOS, are only revealed
    for (const off of [{ rules: rules() }, { platform: 'linux' }]) {
      expect(await openLinkRequest({ kind: 'file', path: code, reveal: false }, { ...deps, ...off })).toEqual({ ok: true, action: 'revealed', reason: 'type' })
    }
  })

  it('checks a rule-opened file for an alias or Open With before it launches anything', async () => {
    const { root, app } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { shell } = recordingShell()
    writeFileSync(join(root, 'alias.py'), BOOKMARK)
    const deps = {
      shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, spawnImpl,
      rules: rules({ types: [{ extension: 'py', handler: 'app', app }] }),
    }
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'alias.py'), reveal: false }, deps)).toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
    expect(await openLinkRequest({ kind: 'file', path: join(root, 'build.py'), reveal: false }, {
      ...deps, execFileImpl: fakeXattr(() => new Error('xattr failed')).execFileImpl,
    })).toEqual({ ok: true, action: 'revealed', reason: 'blocked' })
    expect(calls).toEqual([])
  })

  it('refuses every local file path, rules, Quick Look and Reveal included, in a viewer this app does not own', async () => {
    const { root, app, doc, log } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    const deps = {
      shell, homeDir: root, platform: 'darwin', execFileImpl: noXattr, spawnImpl,
      rules: rules({ markdown: { handler: 'quicklook' }, types: [{ extension: 'log', handler: 'reveal' }, { extension: 'txt', handler: 'app', app }] }),
    }
    writeFileSync(join(root, 'notes.txt'), 'x')
    for (const [path, reveal] of [[doc, false], [log, false], [join(root, 'notes.txt'), false], [doc, true]] as Array<[string, boolean]>) {
      expect(await openLinkRequest({ kind: 'file', path, reveal }, deps), `${path} ${reveal}`).toEqual({ ok: false, reason: 'unowned' })
      expect(await openLinkRequest({ kind: 'file', path, reveal }, { ...deps, filesPermitted: false })).toEqual({ ok: false, reason: 'unowned' })
    }
    expect(calls).toEqual([])
    expect(shellCalls).toEqual([])
    // the same rules apply once main says the viewer is its own
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, { ...deps, filesPermitted: true })).toEqual({ ok: true, action: 'opened' })
    expect(calls.map((call) => call.command)).toEqual(['/usr/bin/qlmanage'])
  })

  it('reveals on request whatever the rule says', async () => {
    const { root, doc } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: true }, {
      shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, spawnImpl, rules: rules({ markdown: { handler: 'quicklook' } }),
    })).toEqual({ ok: true, action: 'revealed', reason: 'requested' })
    expect(calls).toEqual([])
    expect(shellCalls).toEqual([['showItemInFolder', doc]])
  })

  it('reports an app that has gone, a launch that fails and an app that refused', async () => {
    const { root, app, doc } = files()
    const { shell } = recordingShell()
    const markdownApp = rules({ markdown: { handler: 'app', app } })
    const failing = fakeSpawn({ fail: true })
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, { shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, rules: markdownApp, spawnImpl: failing.spawnImpl }))
      .toEqual({ ok: false, reason: 'failed' })
    const refusing = fakeSpawn({ exitCode: 1 })
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, { shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, rules: markdownApp, spawnImpl: refusing.spawnImpl }))
      .toEqual({ ok: false, reason: 'failed' })
    rmSync(app, { recursive: true })
    const gone = fakeSpawn()
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, { shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, rules: markdownApp, spawnImpl: gone.spawnImpl }))
      .toEqual({ ok: false, reason: 'app-missing' })
    expect(gone.calls).toEqual([])
  })

  it('keeps the system defaults off macOS', async () => {
    const { root, app, doc } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, {
      shell, homeDir: root, filesPermitted: true, platform: 'linux', spawnImpl, rules: rules({ markdown: { handler: 'app', app } }),
    })).toEqual({ ok: true, action: 'opened' })
    expect(calls).toEqual([])
    expect(shellCalls).toEqual([['openPath', doc]])
  })

  it('opens web links in the chosen browser, from the preload method and the window’s own open path', async () => {
    const { root, app, realApp } = files()
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    const webApp = rules({ web: { handler: 'app', app } })
    expect(await openLinkRequest({ kind: 'web', url: 'https://example.com/a' }, { shell, homeDir: root, filesPermitted: true, platform: 'darwin', spawnImpl, rules: webApp }))
      .toEqual({ ok: true, action: 'opened' })
    expect(openWebLink('https://example.com/b', shell, { platform: 'darwin', spawnImpl, readRules: async () => webApp })).toBe(true)
    expect(openWebLink('https://example.com/c', shell, { platform: 'darwin', spawnImpl, readRules: async () => { throw new Error('unreadable') } })).toBe(true)
    expect(openWebLink('file:///etc/passwd', shell, { platform: 'darwin', spawnImpl, readRules: async () => webApp })).toBe(false)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(calls.map((call) => call.args)).toEqual([['-a', realApp, '--', 'https://example.com/a'], ['-a', realApp, '--', 'https://example.com/b']])
    expect(shellCalls).toEqual([['openExternal', 'https://example.com/c']])
  })

  it('falls back to the default browser on the window’s own path when the chosen one has gone, is refused or fails', async () => {
    const { root, app, realApp } = files()
    const runner = bundle(root, 'Terminal')
    const settle = () => new Promise((resolve) => setTimeout(resolve, 10))
    for (const [chosen, spawned, exitCode] of [
      ['/Volumes/Gone/Firefox.app', false, 0],
      [runner, false, 0],
      [app, true, 1],
    ] as Array<[string, boolean, number]>) {
      const { calls, spawnImpl } = fakeSpawn({ exitCode })
      const { calls: shellCalls, shell } = recordingShell()
      const webApp = rules({ web: { handler: 'app', app: chosen } })
      expect(openWebLink('https://example.com/pr/1', shell, { platform: 'darwin', spawnImpl, readRules: async () => webApp })).toBe(true)
      await settle()
      expect(calls.map((call) => call.args), chosen).toEqual(spawned ? [['-a', realApp, '--', 'https://example.com/pr/1']] : [])
      expect(shellCalls, chosen).toEqual([['openExternal', 'https://example.com/pr/1']])
    }
  })

  it('checks the chosen app again at launch: its real path, its Info.plist and what it runs', async () => {
    const { root, doc } = files()
    const { shell } = recordingShell()
    const outside = join(root, 'plain-folder')
    mkdirSync(outside)
    const launcher = bundle(root, 'Python Launcher')
    const hollow = bundle(root, 'Hollow')
    rmSync(join(hollow, 'Contents', 'Info.plist'))
    const odd = bundle(root, 'Odd')
    rmSync(join(odd, 'Contents', 'Info.plist'))
    mkdirSync(join(odd, 'Contents', 'Info.plist'))
    const viewer = bundle(join(root, 'real'), 'Viewer')
    const shaped = join(root, 'NotAnApp')
    mkdirSync(join(shaped, 'Contents'), { recursive: true })
    writeFileSync(join(shaped, 'Contents', 'Info.plist'), '<plist/>')
    const link = (name: string, target: string) => {
      symlinkSync(target, join(root, name))
      return join(root, name)
    }
    for (const [app, reason] of [
      [bundle(root, 'Terminal'), 'app-refused'],
      [link('Disguised.app', launcher), 'app-refused'],
      [link('iTerm.app', viewer), 'app-refused'],
      [link('Bin.app', '/bin'), 'app-missing'],
      [link('Folder.app', outside), 'app-missing'],
      [link('Shaped.app', shaped), 'app-missing'],
      [hollow, 'app-missing'],
      [odd, 'app-missing'],
    ] as Array<[string, string]>) {
      const { calls, spawnImpl } = fakeSpawn()
      expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, {
        shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, spawnImpl, rules: rules({ markdown: { handler: 'app', app } }),
      }), app).toEqual({ ok: false, reason })
      expect(calls, app).toEqual([])
    }
    const { calls, spawnImpl } = fakeSpawn()
    expect(await openLinkRequest({ kind: 'file', path: doc, reveal: false }, {
      shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, spawnImpl, rules: rules({ markdown: { handler: 'app', app: link('Alias.app', viewer) } }),
    })).toEqual({ ok: true, action: 'opened' })
    expect(calls.map((call) => call.args)).toEqual([['-a', realpathSync(viewer), '--', doc]])
  })

  // Finder and System Events open what they are handed with its default app,
  // so a rule naming one would be System default for a type off the allow-list
  // (Python Launcher, for a .py); JavaLauncher runs the Java program it opens.
  it.each(['Finder', 'System Events', 'JavaLauncher'])('refuses %s when it is picked, read back and launched', async (name) => {
    const { root, code } = files()
    const app = bundle(root, name)
    expect(await links.launchableApp(app)).toEqual({ error: 'runs-code' })
    if (ON_MAC && existsSync(`/System/Library/CoreServices/${name}.app`)) {
      expect(await links.launchableApp(`/System/Library/CoreServices/${name}.app`)).toEqual({ error: 'runs-code' })
    }
    const stored = { schema: 1, types: [{ extension: 'py', handler: 'app', app }] }
    expect(preferences.parseLinkPreferences(JSON.stringify(stored)).prefs.types).toEqual([])
    const { calls, spawnImpl } = fakeSpawn()
    const { calls: shellCalls, shell } = recordingShell()
    expect(await openLinkRequest({ kind: 'file', path: code, reveal: false }, {
      shell, homeDir: root, filesPermitted: true, platform: 'darwin', execFileImpl: noXattr, spawnImpl,
      rules: rules({ types: [{ extension: 'py', handler: 'app', app }] }),
    })).toEqual({ ok: false, reason: 'app-refused' })
    expect(calls).toEqual([])
    expect(shellCalls).toEqual([])
  })
})

// Issue #324: a repo-relative path arrives with the folder its card recorded.
// Main joins the two, applies exactly the rules above to the result, and
// refuses a path whose symlinks lead outside that folder once resolved.
describe('repo-relative paths: joined to their folder, and kept inside it (issue #324)', () => {
  // a repository with links that stay inside it and links that escape it
  function repository() {
    const base = scratchDir('link-repo-')
    const root = join(base, 'repo')
    const outside = join(base, 'outside')
    mkdirSync(join(root, 'docs', 'specs'), { recursive: true })
    mkdirSync(join(root, 'public'))
    mkdirSync(outside)
    writeFileSync(join(root, 'docs', 'specs', 'spec.md'), '# spec')
    writeFileSync(join(root, 'README.md'), '# readme')
    writeFileSync(join(root, 'public', 'app.js'), 'x')
    writeFileSync(join(root, 'docs', 'alias.md'), BOOKMARK)
    writeFileSync(join(outside, 'secret.md'), 'secret')
    symlinkSync(join(root, 'README.md'), join(root, 'docs', 'readme-link.md'))
    symlinkSync('../README.md', join(root, 'docs', 'relative-link.md'))
    symlinkSync(join(outside, 'secret.md'), join(root, 'docs', 'escape.md'))
    symlinkSync('../../outside/secret.md', join(root, 'docs', 'relative-escape.md'))
    symlinkSync(join(root, 'docs', 'escape.md'), join(root, 'docs', 'chain.md'))
    symlinkSync(outside, join(root, 'vendor'))
    symlinkSync(root, join(base, 'repo-link'))
    return { base, root, outside }
  }
  const deps = () => ({ platform: 'darwin', execFileImpl: fakeXattr().execFileImpl })
  function recordingShell() {
    const calls: Array<[string, string]> = []
    return {
      calls,
      shell: {
        openExternal: async (url: string) => { calls.push(['openExternal', url]) },
        openPath: async (target: string) => { calls.push(['openPath', target]); return '' },
        showItemInFolder: (target: string) => { calls.push(['showItemInFolder', target]) },
      },
    }
  }

  it('opens a document inside the folder by its resolved path, symlinks that stay inside included', async () => {
    const { base, root } = repository()
    const pairs: Array<[string, string]> = [['docs/specs/spec.md', 'docs/specs/spec.md'], ['docs/readme-link.md', 'README.md'], ['docs/relative-link.md', 'README.md']]
    for (const [rel, target] of pairs) {
      expect(await fileOpenPlan(rel, { root, ...deps() }), rel).toEqual({ ok: true, action: 'open', path: realpathSync(join(root, target)) })
    }
    // a folder reached through a symlink (macOS's /tmp → /private/tmp) is judged by its real path
    expect(await fileOpenPlan('docs/specs/spec.md', { root: join(base, 'repo-link'), ...deps() }))
      .toEqual({ ok: true, action: 'open', path: realpathSync(join(root, 'docs', 'specs', 'spec.md')) })
    // then exactly today's rules: a type it does not open, an alias
    expect(await fileOpenPlan('public/app.js', { root, ...deps() })).toMatchObject({ ok: true, action: 'reveal', reason: 'type' })
    expect(await fileOpenPlan('docs/alias.md', { root, ...deps() })).toMatchObject({ ok: true, action: 'reveal', reason: 'blocked' })
  })

  it.each(['docs/escape.md', 'docs/relative-escape.md', 'docs/chain.md', 'vendor/secret.md'])(
    'refuses %s, whose symlinks lead outside the repository, before reading a thing about the file',
    async (rel) => {
      const { root } = repository()
      const { calls, execFileImpl } = fakeXattr()
      expect(await fileOpenPlan(rel, { root, platform: 'darwin', execFileImpl })).toEqual({ ok: false, reason: 'outside' })
      expect(calls).toEqual([])
    },
  )

  it('reports a file the folder does not have, and a folder that has gone, as missing', async () => {
    const { base, root } = repository()
    expect(await fileOpenPlan('docs/specs/not-here.md', { root, ...deps() })).toEqual({ ok: false, reason: 'missing' })
    expect(await fileOpenPlan('docs/specs/spec.md', { root: join(base, 'gone'), ...deps() })).toEqual({ ok: false, reason: 'missing' })
  })

  it('joins only a plain relative path to a plain absolute folder', async () => {
    const { root } = repository()
    const cases: Array<[unknown, unknown]> = [
      ['../outside/secret.md', root], ['docs/../../outside/secret.md', root], ['docs/./specs/spec.md', root], ['./docs/specs/spec.md', root],
      ['docs//specs/spec.md', root], ['docs/specs/', root], ['/etc/hosts', root], ['~/notes.md', root], ['docs\\specs\\spec.md', root],
      ['docs/spec.md:12', root], ['', root], ['docs/a\u0000.md', root], ['docs/a\n.md', root], [`${'a/'.repeat(2100)}x.md`, root], [7, root],
      ['docs/specs/spec.md', 'relative/root'], ['docs/specs/spec.md', ''], ['docs/specs/spec.md', `${root}\n`],
      ['docs/specs/spec.md', '~/repo'], ['docs/specs/spec.md', 7],
    ]
    for (const [rel, folder] of cases) {
      expect(await fileOpenPlan(rel as string, { root: folder as string, ...deps() }), `${String(rel)} in ${String(folder)}`).toEqual({ ok: false, reason: 'invalid' })
    }
    expect(joinRepoPath('docs/specs/spec.md', `${root}/`)).toEqual({ root, path: join(root, 'docs', 'specs', 'spec.md') })
    expect(joinRepoPath('docs/specs/spec.md', `${root}/sub/..`)).toEqual({ root, path: join(root, 'docs', 'specs', 'spec.md') })
  })

  it('opens and reveals for the viewer this app owns, refuses an escape whatever the request, and reads nothing for any other viewer', async () => {
    const { root } = repository()
    const { calls, shell } = recordingShell()
    const owned = { shell, homeDir: '/Users/nobody', filesPermitted: true, ...deps() }
    const spec = realpathSync(join(root, 'docs', 'specs', 'spec.md'))
    expect(await openLinkRequest({ kind: 'file', path: 'docs/specs/spec.md', root, reveal: false }, owned)).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'file', path: 'docs/specs/spec.md', root, reveal: true }, owned)).toEqual({ ok: true, action: 'revealed', reason: 'requested' })
    expect(await openLinkRequest({ kind: 'file', path: 'docs/escape.md', root, reveal: false }, owned)).toEqual({ ok: false, reason: 'outside' })
    expect(await openLinkRequest({ kind: 'file', path: 'docs/escape.md', root, reveal: true }, owned)).toEqual({ ok: false, reason: 'outside' })
    expect(await openLinkRequest({ kind: 'file', path: 'docs/specs/gone.md', root, reveal: false }, owned)).toEqual({ ok: false, reason: 'missing' })
    expect(calls).toEqual([['openPath', spec], ['showItemInFolder', spec]])

    const touched: string[] = []
    const untouched = new Proxy({}, { get(_target, name) { touched.push(String(name)); throw new Error('the filesystem was read') } })
    for (const filesPermitted of [false, undefined]) {
      const other = { shell, homeDir: '/Users/nobody', fsp: untouched, filesPermitted, platform: 'darwin', execFileImpl: () => { touched.push('xattr') } } as never
      expect(await openLinkRequest({ kind: 'file', path: 'docs/specs/spec.md', root, reveal: false }, other)).toEqual({ ok: false, reason: 'unowned' })
      expect(await openLinkRequest({ kind: 'file', path: 'docs/escape.md', root, reveal: true }, other)).toEqual({ ok: false, reason: 'unowned' })
    }
    expect(touched).toEqual([])
    expect(calls).toHaveLength(2)
  })

  it('applies a Settings → Links rule to the resolved file, and never to an escape', async () => {
    const { root, base } = repository()
    const app = join(base, 'QLMarkdown.app')
    mkdirSync(join(app, 'Contents'), { recursive: true })
    writeFileSync(join(app, 'Contents', 'Info.plist'), '<plist/>')
    const spawned: Array<{ command: string, args: string[] }> = []
    const spawnImpl = (command: string, args: string[]) => {
      spawned.push({ command, args })
      const child = Object.assign(new EventEmitter(), { unref: () => {} })
      queueMicrotask(() => { child.emit('spawn'); child.emit('exit', 0) })
      return child
    }
    const { calls, shell } = recordingShell()
    const rules = { web: { handler: 'default' }, markdown: { handler: 'app', app }, types: [] } as unknown as LinkRules
    const owned = { shell, homeDir: '/Users/nobody', filesPermitted: true, rules, spawnImpl, ...deps() }
    expect(await openLinkRequest({ kind: 'file', path: 'docs/specs/spec.md', root, reveal: false }, owned)).toEqual({ ok: true, action: 'opened' })
    expect(await openLinkRequest({ kind: 'file', path: 'docs/escape.md', root, reveal: false }, owned)).toEqual({ ok: false, reason: 'outside' })
    expect(spawned).toEqual([{ command: '/usr/bin/open', args: ['-a', realpathSync(app), '--', realpathSync(join(root, 'docs', 'specs', 'spec.md'))] }])
    expect(calls).toEqual([])
  })

  it.each([
    { kind: 'file', path: 'docs/a.md', root: 7, reveal: false },
    { kind: 'file', path: 'docs/a.md', root: null, reveal: false },
    { kind: 'file', path: 'docs/a.md', root: '/Users/s/repo', reveal: false, extra: 1 },
    { kind: 'file', path: 'docs/a.md', root: '/Users/s/repo' },
    { kind: 'web', url: 'https://example.com', root: '/Users/s/repo' },
  ])('refuses the malformed request %j', async (request) => {
    const { calls, shell } = recordingShell()
    expect(await openLinkRequest(request, { shell, homeDir: '/Users/s', filesPermitted: true })).toEqual({ ok: false, reason: 'invalid' })
    expect(calls).toEqual([])
  })
})
