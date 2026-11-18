// The words the hub's sharing panel and its notifications use (#617, PR 2d): public/remote-words.js,
// the one table from a reason word the controller can give to the sentence a person reads. Every
// reason word is taken from electron/remote-entry.d.cts, so a word added there without a sentence
// fails here.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as words from '../public/remote-words.js'

const types = readFileSync(join(import.meta.dirname, '..', 'electron', 'remote-entry.d.cts'), 'utf8')

/** The string literals of `export type <name> = …`, up to the next declaration. */
function union(name: string): string[] {
  const at = types.indexOf(`export type ${name} =`)
  expect(at, name).toBeGreaterThan(-1)
  const rest = types.slice(at + `export type ${name} =`.length)
  const end = rest.search(/\n(export|\/\*\*|\n)/)
  // a template literal (`serve_not_ok:${ServeReason}`) is expanded by the caller
  const body = (end === -1 ? rest : rest.slice(0, end)).replace(/`[^`]*`/g, '')
  const literals = [...body.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]!)
  const named = [...body.matchAll(/\b([A-Z][A-Za-z]+Reason|RemoteProblem)\b/g)].map((m) => m[1]!).filter((n) => n !== name)
  return [...new Set([...literals, ...named.flatMap(union)])]
}

const SELF = union('SelfReason')
const SERVE = union('ServeReason')
const PROBLEMS = union('RemoteProblem')
const WRITES = union('WriteReason')
const STOPS = union('StopReason')
const WAITING = [...union('ResumeWaiting'), ...SERVE.map((reason) => `serve_not_ok:${reason}`)]
// the self test's and the code request's reason words, from their result types
const resultReasons = (name: string): string[] => {
  const at = types.indexOf(`export type ${name} =`)
  const body = types.slice(at, types.indexOf('\n\n', at))
  return [...body.matchAll(/reason: ((?:'[a-z_]+'(?: \| )?)+)/g)].flatMap((m) => [...m[1]!.matchAll(/'([a-z_]+)'/g)].map((x) => x[1]!))
}
const TESTS = resultReasons('SelfTestResult')
const CODES = resultReasons('CodeResult')

const isSentence = (text: unknown) => typeof text === 'string' && text.trim() === text && text.length > 3 && !/\b(hub|entry|controller|digest|device secret|undefined|null)\b/i.test(text)

describe('the reason lists read from remote-entry.d.cts', () => {
  it('are the lists the controller gives', () => {
    expect(SELF).toEqual(['no_cli', 'failed', 'not_json', 'not_running', 'no_dns_name', 'bad_host', 'tagged', 'no_login'])
    expect(SERVE).toContain('no_handler')
    expect(SERVE).toHaveLength(14)
    expect(STOPS).toEqual(expect.arrayContaining([...SELF, ...SERVE, 'identity_changed', 'not_wanted']))
    expect(STOPS).toHaveLength(SELF.length + SERVE.length + 2)
    expect(PROBLEMS).toContain('open_to_others')
    expect(WRITES).toEqual(expect.arrayContaining([...PROBLEMS, 'port_clash', 'write_failed']))
    expect(WAITING).toEqual(expect.arrayContaining(['tailscale_not_running', 'tailscale_unreadable', 'flagged', 'changed_outside', 'needs_owner', 'write_failed', 'serve_not_ok:funnel']))
    expect(TESTS).toEqual(['off', 'no_status', 'unreachable', 'not_refused', 'no_device_count'])
    expect(CODES).toEqual(['off', 'no_owner_token', 'not_listening', 'refused', 'unreachable', 'bad_answer', 'failed'])
  })
})

describe('every reason word has words', () => {
  const family = (kind: string, reason: string, step?: string) => {
    const key = words.reasonFamily(kind, reason, step)
    const entry = words.FAMILY_WORDS[key as keyof typeof words.FAMILY_WORDS]
    expect(entry, `${kind} ${step ?? ''} ${reason} -> ${String(key)}`).toBeTruthy()
    expect(isSentence(entry.why), `${key}.why`).toBe(true)
    expect(isSentence(entry.refused), `${key}.refused`).toBe(true)
    return { key, entry }
  }

  it('each stop, with one notification sentence per family', () => {
    const notices = new Set<string>()
    for (const reason of STOPS) {
      family('stop', reason)
      const notice = words.stopNotice(reason)
      expect(isSentence(notice), reason).toBe(true)
      notices.add(notice)
    }
    expect([...notices].sort()).toEqual([
      'Sharing is switched off, and the settings file said on.',
      'Tailscale Serve is not set up as expected.',
      'Tailscale is not running, or Agent Inbox can’t read it.',
      'This Mac’s Tailscale name or account changed.',
    ])
    expect(words.stopNotice('identity_changed')).toBe('This Mac’s Tailscale name or account changed.')
    expect(words.stopNotice('tagged')).toBe('This Mac’s Tailscale name or account changed.')
    expect(words.stopNotice('funnel')).toBe('Tailscale Serve is not set up as expected.')
    expect(words.stopNotice('not_wanted')).toBe('Sharing is switched off, and the settings file said on.')
    // a word this build does not know still reads as a sentence
    expect(isSentence(words.stopNotice('something_new'))).toBe(true)
  })

  it('each refusal to switch on, by its step', () => {
    for (const reason of SELF) family('turnOn', reason, 'self')
    for (const reason of SERVE) family('turnOn', reason, 'serve')
    for (const reason of WRITES) family('turnOn', reason, 'file')
    // `unreadable` is a file that cannot be read at the file step, and Tailscale at the Serve step
    expect(words.reasonFamily('turnOn', 'unreadable', 'file')).not.toBe(words.reasonFamily('turnOn', 'unreadable', 'serve'))
  })

  it('each wait before sharing comes back, and each paused one says it comes back by itself', () => {
    for (const word of WAITING) {
      const { key, entry } = family('waiting', word)
      if (!['flagged', 'needs_owner'].includes(word)) expect(isSentence(entry.paused ?? entry.refused), `${key}.paused`).toBe(true)
    }
    expect(words.FAMILY_WORDS[words.reasonFamily('waiting', 'tailscale_not_running') as keyof typeof words.FAMILY_WORDS].paused).toMatch(/comes back by itself/)
  })

  it('each problem with the settings file', () => {
    for (const problem of PROBLEMS) family('problem', problem)
    expect(words.FAMILY_WORDS[words.reasonFamily('problem', 'open_to_others') as keyof typeof words.FAMILY_WORDS].repair).toBe(true)
  })

  it('the families the brief names say what to do', () => {
    const say = (kind: string, reason: string, step?: string) => words.FAMILY_WORDS[words.reasonFamily(kind, reason, step) as keyof typeof words.FAMILY_WORDS]
    expect(say('turnOn', 'no_handler', 'serve')).toMatchObject({ refused: 'Run this once in Terminal on this Mac, then switch on again:', command: true })
    expect(say('turnOn', 'wrong_target', 'serve').command).toBe(true)
    expect(say('turnOn', 'foreground', 'serve').refused).toMatch(/Another tailscale serve is running/)
    expect(say('turnOn', 'services', 'serve').refused).toMatch(/Another tailscale serve is running/)
    expect(say('turnOn', 'tagged', 'self').refused).toMatch(/personal Tailscale login/)
    expect(say('turnOn', 'no_cli', 'self').refused).toMatch(/Install Tailscale/)
    expect(say('turnOn', 'not_running', 'self').refused).toMatch(/Open Tailscale/)
    expect(say('turnOn', 'no_login', 'self').refused).toMatch(/Sign in to Tailscale/)
    expect(say('stop', 'identity_changed').refused).toBe('This Mac’s Tailscale name or account changed. Switching on again removes the paired Macs.')
    expect(say('turnOn', 'other_viewer', 'file').refused).toMatch(/other copy of Agent Inbox/)
    for (const key of Object.keys(words.FAMILY_WORDS)) {
      const entry = words.FAMILY_WORDS[key as keyof typeof words.FAMILY_WORDS]
      if (!('command' in entry && entry.command)) continue
      expect(entry.refused.endsWith(':'), key).toBe(true)
    }
  })

  it('each self-test result and each code refusal', () => {
    expect(words.testWords({ ok: true }, 'mac.example.ts.net')).toBe('Working: Tailscale reaches this Inbox, and it asks for a paired Mac.')
    for (const reason of [...TESTS, 'failed']) {
      for (const rose of [null, 'host', 'login', 'funnel', 'route']) {
        const text = words.testWords({ ok: false, reason, rose }, 'mac.example.ts.net')
        expect(isSentence(text), `${reason} ${rose}`).toBe(true)
        expect(text).not.toMatch(/^Working/)
      }
    }
    expect(words.testWords({ ok: false, reason: 'no_device_count', rose: 'login' }, 'h.example.ts.net')).toMatch(/login/)
    expect(words.testWords({ ok: false, reason: 'unreachable', rose: null }, 'h.example.ts.net')).toContain('https://h.example.ts.net')
    for (const reason of [...CODES, 'something_new']) expect(isSentence(words.codeWords(reason)), reason).toBe(true)
  })
})
