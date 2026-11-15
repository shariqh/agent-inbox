import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  cleanPath, cleanTitle, hiddenReasons, isChatId, isTempFolder, lockPid, parseClaudeLiveFile, parseClaudeWindows,
  parseGitdirPointer, parseGitOrigin, parseWorkspaceYaml, readYamlScalars, retentionDays, sessionFilePid,
} from '../src/chat-parse.js'

const ID = '0a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d'
const rec = (o: Record<string, unknown>) => JSON.stringify(o)
const at = (n: number) => `2026-11-14T10:00:${String(n).padStart(2, '0')}.000Z`

describe('chat-parse (#586)', () => {
  it('isChatId accepts a lowercase UUID only', () => {
    expect(isChatId(ID)).toBe(true)
    for (const bad of [ID.toUpperCase(), `pending-session:${ID}`, `optimistic-${ID}`, '../x', '', `${ID}\n`]) expect(isChatId(bad), bad).toBe(false)
  })

  it('lockPid and sessionFilePid take a pid from 2 up and nothing else', () => {
    expect(lockPid('inuse.123.lock')).toBe(123)
    for (const bad of ['inuse.0.lock', 'inuse.1.lock', 'inuse.-5.lock', 'inuse.99999999999.lock', 'inuse.12.lock.bak', 'inuse..lock']) expect(lockPid(bad), bad).toBeNull()
    expect(sessionFilePid('123.json')).toBe(123)
    for (const bad of ['123.abc.key', '1.json', 'x.json', '123.json.bak']) expect(sessionFilePid(bad), bad).toBeNull()
  })

  it('readYamlScalars reads plain, quoted and block scalars', () => {
    const y = readYamlScalars([
      'a: plain value', "b: 'it''s'", 'c: "a\\"b\\tc"', 'd: |-', '  line one', '  line two', '', 'e: >-', '  fold one', '  fold two', 'f: |', '  keep', 'g: last',
    ].join('\n'), ['a', 'b', 'c', 'd', 'e', 'f', 'g'])
    expect(Object.fromEntries(y)).toEqual({ a: 'plain value', b: "it's", c: 'a"b\tc', d: 'line one\nline two', e: 'fold one fold two', f: 'keep', g: 'last' })
  })

  it('readYamlScalars treats anything else as missing and still reads the neighbours', () => {
    const text = [
      'dup: 1', 'dup: 2', 'nested:', '  child: 1', 'flow: [a]', 'anchor: &x v', 'tag: !t v', 'esc: "\\x41"', 'open: "never closed', 'quote: \'it\'s\'',
      '  indented: 1', 'ok: fine',
    ].join('\n')
    const y = readYamlScalars(text, ['dup', 'nested', 'flow', 'anchor', 'tag', 'esc', 'open', 'quote', 'indented', 'ok'])
    expect([...y.keys()]).toEqual(['ok'])
  })

  it('parseWorkspaceYaml maps every field', () => {
    const meta = parseWorkspaceYaml([
      `id: ${ID}`, 'cwd: /Users/example/dev/widget', 'git_root: /Users/example/dev/widget', 'repository: example/widget', 'branch: main',
      'client_name: github/cli', 'user_named: true', 'name: My named chat', 'created_at: 2026-11-14T09:00:00.000Z', 'updated_at: 2026-11-14T10:00:00.000Z',
    ].join('\n'))
    expect(meta).toEqual({
      id: ID, cwd: '/Users/example/dev/widget', gitRoot: '/Users/example/dev/widget', branch: 'main', repository: 'example/widget',
      title: 'My named chat', createdAt: '2026-11-14T09:00:00.000Z', updatedAt: '2026-11-14T10:00:00.000Z', clientName: 'github/cli',
    })
  })

  it('parseWorkspaceYaml gives null without a valid id, and a null title when nothing was named', () => {
    expect(parseWorkspaceYaml('cwd: /x')).toBeNull()
    expect(parseWorkspaceYaml('id: pending-session:abc')).toBeNull()
    expect(parseWorkspaceYaml(`id: ${ID}`)?.title).toBeNull()
    expect(parseWorkspaceYaml(`id: ${ID}\nuser_named: true`)?.title).toBeNull()
  })

  it('parseWorkspaceYaml never returns an automatic name, which is the start of the first prompt', () => {
    const block = parseWorkspaceYaml(`id: ${ID}\nname: |-\n  SECRET-PROMPT explain the thing\n  second line\nuser_named: false`)
    const inline = parseWorkspaceYaml(`id: ${ID}\nname: SECRET-PROMPT short\nuser_named: false`)
    const unset = parseWorkspaceYaml(`id: ${ID}\nname: SECRET-PROMPT short`)
    for (const meta of [block, inline, unset]) {
      expect(meta).not.toBeNull()
      expect(JSON.stringify(meta)).not.toContain('SECRET')
    }
  })

  it('reads a pathological line of blanks and a lone \\r in linear time', () => {
    const blanks = ' '.repeat(60_000)
    const t0 = performance.now()
    expect(readYamlScalars(`summary:${blanks}\rz\nid: ${ID}`, ['id', 'summary']).get('id')).toBe(ID)
    expect(parseGitOrigin(`[remote "origin"]\n\turl = a${blanks}\rb\n\turl = ok`)).toBe('ok')
    expect(performance.now() - t0).toBeLessThan(1000)
    // blanks around a value are still trimmed, and a tab leads as well as a space
    expect([...readYamlScalars('a:\t  b c  \t', ['a'])]).toEqual([['a', 'b c']])
  })

  it('parseClaudeWindows: cwd and entrypoint from the first record, branch and times from the last, last ai-title, last pr-link', () => {
    const pr = (n: number) => rec({ type: 'pr-link', prNumber: n, prRepository: 'example/widget', prUrl: `https://github.com/example/widget/pull/${n}`, timestamp: at(n) })
    const head = [
      rec({ type: 'user', cwd: '/Users/example/dev/widget', gitBranch: 'main', entrypoint: 'cli', timestamp: at(1) }),
      rec({ type: 'ai-title', aiTitle: 'First title', sessionId: ID }),
      rec({ type: 'user', cwd: '/Users/example/dev/widget/sub', gitBranch: 'feature', timestamp: at(2) }),
      '',
    ].join('\n')
    const tail = ['cut-off-first-line', rec({ type: 'ai-title', aiTitle: 'Second title' }), pr(7), pr(8), rec({ type: 'assistant', gitBranch: 'later', timestamp: at(9) }), ''].join('\n')
    expect(parseClaudeWindows(head, tail, false)).toEqual({
      cwd: '/Users/example/dev/widget', branch: 'later', createdAt: at(1), lastActiveAt: at(9), entrypoint: 'cli', title: 'Second title',
      pr: { number: 8, repo: 'example/widget', url: 'https://github.com/example/widget/pull/8' },
    })
  })

  it('parseClaudeWindows: a custom-title outranks the last ai-title, and a bad prUrl gives no PR', () => {
    const meta = parseClaudeWindows([
      rec({ type: 'custom-title', customTitle: 'Typed by hand' }),
      rec({ type: 'ai-title', aiTitle: 'Generated' }),
      rec({ type: 'pr-link', prNumber: 3, prRepository: 'example/widget', prUrl: 'https://evil.example/pull/3' }),
    ].join('\n'), null, true)
    expect(meta.title).toBe('Typed by hand')
    expect(meta.pr).toBeNull()
  })

  it('parseClaudeWindows drops cut lines: the tail first line and a cut head last line', () => {
    const valid = rec({ type: 'ai-title', aiTitle: 'Should not count' })
    expect(parseClaudeWindows('', `${valid}\n${rec({ type: 'user', timestamp: at(5) })}\n`, false).title).toBeNull()
    expect(parseClaudeWindows(`${rec({ type: 'user', timestamp: at(1) })}\n${valid}`, null, false).title).toBeNull()
    expect(parseClaudeWindows(`${rec({ type: 'user', timestamp: at(1) })}\n${valid}`, null, true).title).toBe('Should not count')
  })

  it('parseClaudeWindows never returns message text', () => {
    const text = [
      rec({ type: 'user', cwd: '/Users/example/dev/widget', message: { role: 'user', content: 'SECRET-PROMPT' }, timestamp: at(1) }),
      rec({ type: 'last-prompt', lastPrompt: 'SECRET-PROMPT', sessionId: ID }),
      rec({ type: 'assistant', message: { content: [{ type: 'text', text: 'SECRET-PROMPT' }] } }),
      '',
    ].join('\n')
    expect(JSON.stringify(parseClaudeWindows(text, text, false))).not.toContain('SECRET')
  })

  it('cleanTitle collapses lines, strips controls and caps at 200', () => {
    expect(cleanTitle('a\n\tb\r\nc')).toBe('a b c')
    expect(cleanTitle('x\u0007y\u0085z\u202ew')).toBe('xyzw')
    expect(cleanTitle('é'.repeat(300))).toBe('é'.repeat(200))
    for (const bad of ['', '  \n ', 5, null, undefined, {}]) expect(cleanTitle(bad)).toBeNull()
  })

  it('cleanPath wants one absolute POSIX path without controls', () => {
    expect(cleanPath('/Users/example/dev')).toBe('/Users/example/dev')
    for (const bad of ['relative/x', '', '/a\0b', '/a\nb', `/${'x'.repeat(5000)}`, 'C:\\Users\\x', 7]) expect(cleanPath(bad), String(bad)).toBeNull()
  })

  it('isTempFolder matches the temp roots and what is under them', () => {
    for (const p of ['/tmp', '/tmp/x', '/private/tmp/x', '/var/folders/ab/x', '/private/var/folders/x']) expect(isTempFolder(p), p).toBe(true)
    for (const p of ['/tmpfoo', '/Users/example/tmp', '/var/foldersx', '/']) expect(isTempFolder(p), p).toBe(false)
  })

  it('hiddenReasons: Claude entrypoints', () => {
    expect(hiddenReasons({ tool: 'claude', folder: '/Users/example/a', entrypoint: 'sdk-cli' })).toEqual(['non-interactive'])
    expect(hiddenReasons({ tool: 'claude', folder: '/Users/example/a', entrypoint: 'cli' })).toEqual([])
    expect(hiddenReasons({ tool: 'claude', folder: '/Users/example/a', entrypoint: 'claude-vscode' })).toEqual([])
    expect(hiddenReasons({ tool: 'claude', folder: null, entrypoint: null })).toEqual([])
  })

  it('hiddenReasons: Copilot clients, events and temp folders combine in a fixed order', () => {
    const base = { tool: 'copilot' as const, folder: '/Users/example/a', hasEvents: true }
    expect(hiddenReasons({ ...base, clientName: 'github/cli' })).toEqual([])
    expect(hiddenReasons({ ...base, clientName: 'github/autopilot' })).toEqual([])
    expect(hiddenReasons({ ...base, clientName: null })).toEqual([])
    expect(hiddenReasons({ ...base, clientName: 'agent-inbox-driver' })).toEqual(['non-interactive'])
    expect(hiddenReasons({ ...base, hasEvents: false })).toEqual(['empty'])
    expect(hiddenReasons({ ...base, folder: '/tmp/x', clientName: 'agent-inbox-driver', hasEvents: false })).toEqual(['temp', 'non-interactive', 'empty'])
  })

  it('parseGitdirPointer and parseGitOrigin read git files', () => {
    expect(parseGitdirPointer('gitdir: /r/.git/worktrees/x\n')).toBe('/r/.git/worktrees/x')
    expect(parseGitdirPointer('not a pointer')).toBeNull()
    const cfg = '[core]\n\tbare = false\n[remote "upstream"]\n\turl = git@github.com:other/widget.git\n[remote "origin"]\n\turl = git@github.com:example/widget.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n'
    expect(parseGitOrigin(cfg)).toBe('git@github.com:example/widget.git')
    expect(parseGitOrigin('[remote "upstream"]\n\turl = x\n')).toBeNull()
    expect(parseGitOrigin('')).toBeNull()
  })

  it('parseClaudeLiveFile refuses a pid that is not the file name and a non-UUID session', () => {
    expect(parseClaudeLiveFile(JSON.stringify({ pid: 42, sessionId: ID, startedAt: 1700000000000 }), 42)).toEqual({ sessionId: ID, startedAt: 1700000000000 })
    expect(parseClaudeLiveFile(JSON.stringify({ pid: 42, sessionId: ID }), 42)).toEqual({ sessionId: ID, startedAt: null })
    expect(parseClaudeLiveFile(JSON.stringify({ pid: 43, sessionId: ID }), 42)).toBeNull()
    expect(parseClaudeLiveFile(JSON.stringify({ pid: 42, sessionId: '../x' }), 42)).toBeNull()
    expect(parseClaudeLiveFile('{not json', 42)).toBeNull()
  })

  it('retentionDays is cleanupPeriodDays when positive, else 30', () => {
    expect(retentionDays('{"cleanupPeriodDays":14}')).toBe(14)
    for (const bad of ['{"cleanupPeriodDays":0}', '{"cleanupPeriodDays":-3}', '{"cleanupPeriodDays":"14"}', '{"cleanupPeriodDays":null}', '{', 'null', null]) expect(retentionDays(bad), String(bad)).toBe(30)
  })

  it('chat-parse.ts is pure: no import, no clock, no process, no disk', () => {
    const src = readFileSync(join(import.meta.dirname, '..', 'src', 'chat-parse.ts'), 'utf8')
    expect(src).not.toMatch(/^\s*import\s/m)
    expect(src).not.toMatch(/from\s+['"]|node:|process\.|Date\.now|new Date\(|require\(|Math\.random/)
  })
})
