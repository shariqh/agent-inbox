// #466 PR 3: the opt-in Copilot CLI hooks installer. Scratch HOMEs only: no
// test here may read or write the real ~/.copilot.
import { describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { copilotHooksFile, isOurs } from '../scripts/copilot-hooks.mjs'
import { scratchDir } from './scratch.js'

const REPO = fileURLToPath(new URL('..', import.meta.url))
const SCRIPT = join(REPO, 'scripts', 'install-copilot-hooks.sh')

function home(): { dir: string; entry: string; file: string } {
  const dir = scratchDir('copilot-hooks-home-')
  const entry = join(dir, 'stub', 'dist', 'hook-cli.js')
  mkdirSync(join(dir, 'stub', 'dist'), { recursive: true })
  writeFileSync(entry, 'process.exit(0)\n') // stands in for a built dist/hook-cli.js whose selftest passes
  return { dir, entry, file: join(dir, '.copilot', 'hooks', 'agent-inbox.json') }
}

function installer(args: string[], dir: string, entry: string) {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: dir, AGENT_INBOX_HOOK_ENTRY: entry, AGENT_INBOX_NODE: process.execPath }
  delete env.COPILOT_HOME
  const r = spawnSync('bash', [SCRIPT, ...args], { encoding: 'utf8', env })
  return { code: r.status, out: r.stdout, err: r.stderr }
}

const kinds = (file: string) => Object.fromEntries(Object.entries(JSON.parse(readFileSync(file, 'utf8')).hooks)
  .map(([event, list]) => [event, (list as Array<{ args: string[] }>)[0]!.args[2]]))

describe('Copilot CLI hooks file (#466 PR 3)', () => {
  it('maps each event to its stamp in exec form, never preToolUse, and drops the tool hook on request', () => {
    const file = copilotHooksFile('/n/node', '/a/dist/hook-cli.js')
    expect(Object.keys(file.hooks)).not.toContain('preToolUse')
    expect(file.hooks.postToolUse).toEqual([{ type: 'command', exec: '/n/node', args: ['/a/dist/hook-cli.js', 'activity', 'tool'], timeoutSec: 5 }])
    expect(copilotHooksFile('/n/node', '/a/dist/hook-cli.js', { tools: false }).hooks).not.toHaveProperty('postToolUse')
    expect(isOurs(file)).toBe(true)
    expect(isOurs({ version: 1, hooks: { ...file.hooks, preToolUse: file.hooks.postToolUse } })).toBe(false)
    expect(isOurs({ version: 1, hooks: { postToolUse: [{ type: 'command', bash: './lint.sh' }] } })).toBe(false)
    expect(isOurs(null)).toBe(false)
  })

  it('dry run is the default and writes nothing; --apply writes the one file; --uninstall removes it with a backup', () => {
    const { dir, entry, file } = home()
    const dry = installer([], dir, entry)
    expect(dry.code, dry.err).toBe(0)
    expect(dry.err).toMatch(/dry run/)
    expect(isOurs(JSON.parse(dry.out))).toBe(true)
    expect(existsSync(join(dir, '.copilot'))).toBe(false)

    expect(installer(['--apply'], dir, entry).code).toBe(0)
    expect(kinds(file)).toEqual({ userPromptSubmitted: 'turn', agentStop: 'idle', errorOccurred: 'idle', postToolUse: 'tool', sessionEnd: 'end' })
    expect(JSON.parse(readFileSync(file, 'utf8')).hooks.agentStop[0].exec).toBe(process.execPath)

    expect(installer(['--apply', '--no-tool-stamps'], dir, entry).code).toBe(0)
    expect(kinds(file)).not.toHaveProperty('postToolUse')
    // the replaced copy is backed up under a name Copilot never loads (not *.json)
    const hooks = readdirSync(join(dir, '.copilot', 'hooks'))
    expect(hooks.filter((name) => name.endsWith('.json'))).toEqual(['agent-inbox.json'])
    expect(hooks.some((name) => name.startsWith('agent-inbox.json.bak.'))).toBe(true)

    expect(installer(['--uninstall'], dir, entry).err).toMatch(/dry run: would remove/)
    expect(existsSync(file)).toBe(true)
    expect(installer(['--apply', '--uninstall'], dir, entry).code).toBe(0)
    expect(existsSync(file)).toBe(false)
    expect(installer(['--apply', '--uninstall'], dir, entry).err).toMatch(/nothing to remove/)
  })

  it('refuses a file it did not write, and a symlink, in every mode, and leaves them alone', () => {
    const { dir, entry, file } = home()
    mkdirSync(join(dir, '.copilot', 'hooks'), { recursive: true })
    const theirs = JSON.stringify({ version: 1, hooks: { postToolUse: [{ type: 'command', bash: './lint.sh' }] } })
    writeFileSync(file, theirs)
    for (const args of [[], ['--apply'], ['--apply', '--uninstall']]) {
      const r = installer(args, dir, entry)
      expect(r.code, args.join(' ')).toBe(1)
      expect(r.err).toMatch(/not an Agent Inbox hooks file/)
    }
    expect(readFileSync(file, 'utf8')).toBe(theirs)
    const linked = home()
    mkdirSync(join(linked.dir, '.copilot', 'hooks'), { recursive: true })
    symlinkSync(file, linked.file)
    expect(installer(['--apply'], linked.dir, linked.entry)).toMatchObject({ code: 1, err: expect.stringMatching(/not a regular file/) })
  })

  it('refuses before writing when the entry is not built or its Node cannot open the hub', () => {
    const { dir, file } = home()
    expect(installer(['--apply'], dir, join(dir, 'missing', 'hook-cli.js'))).toMatchObject({ code: 1, err: expect.stringMatching(/npm run build/) })
    const failing = join(dir, 'failing-cli.js')
    writeFileSync(failing, 'process.exit(1)\n')
    expect(installer(['--apply'], dir, failing)).toMatchObject({ code: 1, err: expect.stringMatching(/selftest' failed/) })
    expect(existsSync(file)).toBe(false)
  })
})
