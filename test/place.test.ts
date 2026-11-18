// public/place.js: the pure page module for where a session runs (#617, PR 1).
// It re-checks every value against the same patterns the server stored it under,
// so a row written by anything else still never makes a link or a command from
// text that is not a plain name. Synthetic fixtures only.
import { describe, expect, it } from 'vitest'
import { attachCommand, claudeSessionUrl, placeLine } from '../public/place.js'

const NAME_64 = `a${'b'.repeat(63)}`
const BAD_NAMES = ['', ' ', 'my desk', "it's", '"q"', '$(id)', '`id`', 'a;b', '-x', '--help', '.hidden', '..', 'a'.repeat(65), 'a\nb', ' a', 'a ', '<b>x</b>', "'; rm -rf ~; '", '=a', 'é', 'a/b', 'a\\b']

describe('placeLine', () => {
  it('is "machine · desk", "machine" or nothing', () => {
    expect(placeLine({ machine: 'hub', desk: 'api' })).toBe('hub · api')
    expect(placeLine({ machine: 'hub' })).toBe('hub')
    expect(placeLine({ machine: 'hub', desk: null })).toBe('hub')
    expect(placeLine({ machine: 'hub', pane: '%3', remote_session: 'session_a' })).toBe('hub')
    expect(placeLine({})).toBe('')
    expect(placeLine({ pane: '%3', remote_session: 'session_a' })).toBe('')
  })

  it('is nothing for a row of an older server, a row that is not a row, and values that are not strings', () => {
    expect(placeLine({ session: 's', project: 'p', doing: 'open' })).toBe('')
    for (const row of [null, undefined, 'hub', 42, [], true]) expect(placeLine(row as never), String(row)).toBe('')
    expect(placeLine({ machine: 42, desk: ['api'] } as never)).toBe('')
    expect(placeLine({ machine: { toString: () => 'hub' } } as never)).toBe('')
  })

  it('shows a name only when it passes its pattern, never trimmed or cut', () => {
    for (const bad of BAD_NAMES) {
      expect(placeLine({ machine: bad, desk: 'api' }), JSON.stringify(bad)).toBe('')
      expect(placeLine({ machine: 'hub', desk: bad }), JSON.stringify(bad)).toBe('hub')
    }
    expect(placeLine({ machine: NAME_64, desk: NAME_64 })).toBe(`${NAME_64} · ${NAME_64}`)
  })
})

describe('claudeSessionUrl', () => {
  it('is https://claude.ai/code/<remote_session> from a valid id', () => {
    expect(claudeSessionUrl({ remote_session: 'session_01AbCd' })).toBe('https://claude.ai/code/session_01AbCd')
    expect(claudeSessionUrl({ remote_session: `session_${'x'.repeat(64)}` })).toBe(`https://claude.ai/code/session_${'x'.repeat(64)}`)
  })

  it('is empty for anything else: no id, a bad id, a URL, another type', () => {
    const bad = ['', 'session_', 'session', 'Session_a', 'session_a-b', 'session_a_b', 'session_a b', 'session_a\n', ' session_a', `session_${'x'.repeat(65)}`,
      '../session_a', 'session_/x', 'javascript:alert(1)', 'https://evil.example/session_a', 'session_a/../../x', 'session_a?x=1', 'session_a#x', 'session_é', 'session_a"onclick="x']
    for (const id of bad) expect(claudeSessionUrl({ remote_session: id }), JSON.stringify(id)).toBe('')
    for (const row of [{}, { remote_session: null }, { remote_session: 42 }, { remote_session: ['session_a'] }, null, undefined, 'session_a']) {
      expect(claudeSessionUrl(row as never), JSON.stringify(row)).toBe('')
    }
  })

  it('does not read the desk, the machine or any other field', () => {
    expect(claudeSessionUrl({ machine: 'hub', desk: 'api', pane: '%3' })).toBe('')
  })
})

describe('attachCommand', () => {
  it("is exactly tmux attach -t '=<desk>', with the single quotes", () => {
    expect(attachCommand({ desk: 'api' })).toBe("tmux attach -t '=api'")
    expect(attachCommand({ machine: 'hub', desk: 'api-2.x_y' })).toBe("tmux attach -t '=api-2.x_y'")
    expect(attachCommand({ desk: NAME_64 })).toBe(`tmux attach -t '=${NAME_64}'`)
  })

  it('is empty without a desk that passes the pattern', () => {
    for (const bad of BAD_NAMES) expect(attachCommand({ desk: bad }), JSON.stringify(bad)).toBe('')
    for (const row of [{}, { desk: null }, { desk: 42 }, { desk: ['api'] }, { machine: 'hub' }, null, undefined, 'api']) {
      expect(attachCommand(row as never), JSON.stringify(row)).toBe('')
    }
  })

  it('never holds a quote, a space or a shell character that came from the row', () => {
    for (const desk of ['a', 'a-b', 'a.b', '_a', NAME_64]) expect(attachCommand({ desk })).toMatch(/^tmux attach -t '=[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}'$/)
  })
})
