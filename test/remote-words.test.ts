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

// one style throughout (review round 1, item 13): "couldn't", never "could not"; no placeholder left unfilled
const isSentence = (text: unknown) => typeof text === 'string' && text.trim() === text && text.length > 3
  && !/\b(hub|entry|controller|digest|device secret|undefined|null|could not|devices)\b/i.test(text) && !/[{}]/.test(text)
const LISTEN = union('ListenError')

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
    expect(TESTS).toEqual(['off', 'not_listening', 'port_in_use', 'cannot_listen', 'no_status', 'unreachable', 'no_backend', 'not_refused', 'no_device_count'])
    expect(CODES).toEqual(['off', 'no_owner_token', 'not_listening', 'refused', 'unreachable', 'bad_answer', 'failed'])
  })
})

describe('every reason word has words', () => {
  const VALUES = { port: 4320, count: 3 }
  const family = (kind: string, reason: string, step?: string) => {
    const key = words.reasonFamily(kind, reason, step)
    const entry = words.familyWords(key, VALUES)
    expect(entry, `${kind} ${step ?? ''} ${reason} -> ${String(key)}`).toBeTruthy()
    // the status line's reason is a clause: no full stop
    expect(isSentence(entry.why) && !entry.why.endsWith('.'), `${key}.why: ${entry.why}`).toBe(true)
    expect(isSentence(entry.refused), `${key}.refused`).toBe(true)
    return { key, entry }
  }

  it('each stop', () => {
    for (const reason of STOPS) family('stop', reason)
    // a word this build does not know still has words
    expect(words.reasonFamily('stop', 'something_new')).toBe('failed')
  })

  it('each refusal to switch on, by its step, and the one that would remove paired Macs', () => {
    for (const reason of SELF) family('turnOn', reason, 'self')
    for (const reason of SERVE) family('turnOn', reason, 'serve')
    for (const reason of [...WRITES, 'would_remove_devices']) family('turnOn', reason, 'file')
    // `unreadable` is a file that cannot be read at the file step, and Tailscale at the Serve step
    expect(words.reasonFamily('turnOn', 'unreadable', 'file')).not.toBe(words.reasonFamily('turnOn', 'unreadable', 'serve'))
    expect(words.familyWords('would_remove', { port: 4320, count: 3 }).refused)
      .toBe('This Mac’s Tailscale name or account is not the one these Macs were paired under. Switching on removes the 3 paired Macs; pair them again afterwards.')
    expect(words.familyWords('would_remove', { port: 4320, count: 1 }).refused)
      .toBe('This Mac’s Tailscale name or account is not the one this Mac was paired under. Switching on removes the paired Mac; pair it again afterwards.')
  })

  it('each wait before sharing comes back, including the Tailscale reading behind it, with what to do while paused', () => {
    for (const word of [...WAITING, ...SELF.map((reason) => `self_not_ok:${reason}`)]) {
      const { key, entry } = family('waiting', word)
      if (!['flagged', 'needs_owner'].includes(word)) expect(isSentence(entry.paused ?? entry.refused), `${key}.paused`).toBe(true)
    }
    // signed out and not installed read as that while paused, not as "check that Tailscale is running"
    expect(words.familyWords(words.reasonFamily('waiting', 'self_not_ok:no_login'), VALUES).why).toBe('Tailscale is signed out')
    expect(words.familyWords(words.reasonFamily('waiting', 'self_not_ok:no_cli'), VALUES).why).toBe('Tailscale is not installed')
  })

  it('each problem with the settings file, and each bind failure', () => {
    for (const problem of PROBLEMS) family('problem', problem)
    expect(words.familyWords(words.reasonFamily('problem', 'open_to_others'), VALUES).repair).toBe(true)
    expect(LISTEN).toEqual(['port_in_use', 'cannot_listen'])
    for (const reason of LISTEN) family('listen', reason)
    expect(words.familyWords('port_in_use', VALUES)).toMatchObject({
      why: 'another program on this Mac is using port 4320',
      refused: 'Quit that program, or switch sharing off. Until then Tailscale forwards your other Macs to it.',
    })
  })

  it('says what each reason means, as electron/remote-tailscale.cjs reads it (review round 1, item 11)', () => {
    const say = (kind: string, reason: string, step?: string) => words.familyWords(words.reasonFamily(kind, reason, step), VALUES)
    expect(say('turnOn', 'no_handler', 'serve')).toMatchObject({ refused: 'Run this once in Terminal on this Mac, then switch on again:', command: true })
    for (const reason of ['wrong_target', 'handler_fields']) {
      expect(say('turnOn', reason, 'serve'), reason).toMatchObject({ refused: 'Tailscale Serve on this Mac is forwarding this address to something else. This replaces it:', command: true })
    }
    for (const reason of ['not_https', 'unknown_shape']) {
      expect(say('turnOn', reason, 'serve'), reason).toMatchObject({
        refused: 'Tailscale Serve on this Mac is set up in a way Agent Inbox doesn’t recognise. Run this in Terminal to see it:', command: 'tailscale serve status',
      })
    }
    expect(say('turnOn', 'services', 'serve').refused).toMatch(/^A Tailscale Service is set up on this Mac/)
    expect(say('turnOn', 'foreground', 'serve').refused).toMatch(/^Another tailscale serve is running/)
    expect(say('turnOn', 'tagged', 'self').refused).toMatch(/personal Tailscale login/)
    expect(say('turnOn', 'no_cli', 'self').refused).toMatch(/Install Tailscale/)
    expect(say('turnOn', 'not_running', 'self').refused).toMatch(/Open Tailscale/)
    expect(say('turnOn', 'no_login', 'self').refused).toMatch(/Sign in to Tailscale/)
    expect(say('stop', 'identity_changed').refused).toBe('This Mac’s Tailscale name or account changed. Switching on again removes the paired Macs.')
    expect(say('stop', 'not_wanted').refused).toBe('Sharing was switched on outside Agent Inbox while it was switched off here, so Agent Inbox switched it off again.')
    expect(say('turnOn', 'other_viewer', 'file').refused).toMatch(/other copy of Agent Inbox/)
    for (const key of ['serve_setup', 'serve_replace', 'serve_unknown']) {
      const entry = words.familyWords(key, VALUES)
      expect(entry.refused.endsWith(':'), key).toBe(true)
      expect((entry.paused ?? entry.refused).endsWith(':'), key).toBe(true)
    }
  })

  it('each self-test result and each code refusal', () => {
    expect(words.testWords({ ok: true }, 'mac.example.ts.net', 4320)).toBe('Working: Tailscale reaches this Inbox, and it asks for a paired Mac.')
    for (const reason of [...TESTS, 'failed']) {
      for (const rose of [null, 'host', 'login', 'funnel', 'route']) {
        const text = words.testWords({ ok: false, reason, rose }, 'mac.example.ts.net', 4320)
        expect(isSentence(text), `${reason} ${rose}`).toBe(true)
        expect(text).not.toMatch(/^Working/)
      }
    }
    expect(words.testWords({ ok: false, reason: 'no_device_count', rose: 'login' }, 'h.example.ts.net', 4320)).toMatch(/login/)
    expect(words.testWords({ ok: false, reason: 'unreachable', rose: null }, 'h.example.ts.net', 4320)).toContain('https://h.example.ts.net')
    // #617 PR 2d: nothing listening yet, a port another program holds, and Serve with nothing behind it
    expect(words.testWords({ ok: false, reason: 'not_listening', rose: null }, 'h.example.ts.net', 4320)).toBe('Sharing is still starting. Try again in a moment.')
    expect(words.testWords({ ok: false, reason: 'port_in_use', rose: null }, 'h.example.ts.net', 4320))
      .toBe('Another program on this Mac is using port 4320. Quit that program, or switch sharing off. Until then Tailscale forwards your other Macs to it.')
    expect(words.testWords({ ok: false, reason: 'no_backend', rose: null }, 'h.example.ts.net', 4320)).toBe('Tailscale is forwarding, but this Inbox isn’t answering.')
    const sentences = new Set([...TESTS, 'failed'].map((reason) => words.testWords({ ok: false, reason, rose: null }, 'h.example.ts.net', 4320)))
    expect(sentences.size).toBe(TESTS.length + 1)
    for (const reason of [...CODES, 'something_new']) expect(isSentence(words.codeWords(reason)), reason).toBe(true)
  })
})
