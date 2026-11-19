// @vitest-environment jsdom
// test/dom/desk-open.test.ts — #617 PR 4b: public/desk-open.js, Open desk on the page. It asks
// `agentInboxDesk.available()` once and again on each connection change, offers the button only
// for a row with a desk, sends `{ session }` and nothing else, and says each refusal in one
// sentence beside the button. The bridge is a stub of electron/remote-preload.cjs's; nothing opens.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DESK_FALLBACK, DESK_REFUSALS, OPEN_DESK, deskRefusal, deskSession, installDeskOpen } from '../../public/desk-open.js'

const SESSION = '00000000-0000-4000-8000-000000000001'
const ROW = { session: SESSION, machine: 'studio', desk: 'my-desk' }

function hubDesk(open = true) {
  let listener: ((value: unknown) => void) | null = null
  const desk = {
    answer: { open } as unknown,
    available: vi.fn(async () => desk.answer),
    open: vi.fn(async (_request: { session: string }): Promise<unknown> => ({ ok: true })),
    onConnection: vi.fn((callback: (value: unknown) => void) => { listener = callback; return () => { listener = null } }),
    emit: () => listener?.({ mode: 'hub', label: 'studio', state: 'online', version: '2.13.0' }),
  }
  return desk
}

const flush = async () => {
  for (let i = 0; i < 6; i += 1) await Promise.resolve()
}

beforeEach(() => {
  vi.useFakeTimers()
  document.body.replaceChildren()
})
afterEach(() => {
  vi.useRealTimers()
  document.body.replaceChildren()
})

describe('the words', () => {
  it('has one sentence per refusal, and a fallback for anything else', () => {
    expect(DESK_REFUSALS).toEqual({
      no_gesture: 'Press Open desk again.',
      busy: 'One moment: a desk was just opened.',
      no_command: 'Set the Open desk command in Settings on this Mac first.',
      unreachable: 'That Mac’s Inbox could not be reached. Try again.',
      not_found: 'That session is no longer listed.',
      no_desk: 'That session is no longer in a tmux desk.',
      not_on_hub: 'That session runs on a different machine.',
      terminal_failed: 'The terminal did not open. Check Settings → Terminal on this Mac.',
    })
    expect(DESK_FALLBACK).toBe('The desk could not be opened.')
    for (const reason of ['failed', 'unavailable', 'bad_request', 'toString', '__proto__', undefined, 7]) expect(deskRefusal(reason)).toBe(DESK_FALLBACK)
    expect(OPEN_DESK).toBe('Open desk')
  })

  it('offers a row only with a pattern-checked desk and a session id', () => {
    expect(deskSession(ROW)).toBe(SESSION)
    expect(deskSession({ ...ROW, session: 'launch:abc' })).toBe('launch:abc')
    for (const row of [null, 'x', { session: SESSION }, { ...ROW, desk: 'my desk' }, { ...ROW, desk: '-x' }, { ...ROW, desk: 7 },
      { ...ROW, session: '' }, { ...ROW, session: 'a b' }, { ...ROW, session: 7 }]) {
      expect(deskSession(row), JSON.stringify(row)).toBe('')
    }
  })
})

describe('installDeskOpen', () => {
  it('asks once at start and again on each connection change, and repaints only when the answer changes', async () => {
    const desk = hubDesk(false)
    const onChange = vi.fn()
    const opener = installDeskOpen({ desk: () => desk, onChange })
    await opener.ready()
    expect([desk.available.mock.calls.length, opener.available(), onChange.mock.calls.length]).toEqual([1, false, 0])
    desk.answer = { open: true }
    desk.emit()
    await opener.ready()
    expect([desk.available.mock.calls.length, opener.available(), onChange.mock.calls.length]).toEqual([2, true, 1])
    desk.emit()
    await opener.ready()
    expect([desk.available.mock.calls.length, onChange.mock.calls.length]).toEqual([3, 1])
    desk.answer = null
    desk.emit()
    await opener.ready()
    expect([opener.available(), onChange.mock.calls.length]).toEqual([false, 2])
  })

  it('offers nothing with no bridge, a bridge without open (This Mac’s), an answer that is not { open: true }, or one that throws', async () => {
    for (const desk of [
      null,
      { available: vi.fn(async () => ({ open: true })) },
      { ...hubDesk(), available: vi.fn(async () => ({ open: 'yes' })) },
      { ...hubDesk(), available: vi.fn(async () => { throw new Error('gone') }) },
    ]) {
      const opener = installDeskOpen({ desk: () => desk as never })
      await opener.ready()
      expect(opener.available()).toBe(false)
      expect(opener.control(document, ROW)).toBeNull()
    }
  })

  it('draws a button and a hidden sentence for a row with a desk, and nothing for one without', async () => {
    const opener = installDeskOpen({ desk: () => hubDesk() })
    await opener.ready()
    const control = opener.control(document, ROW)!
    expect(control.className).toBe('desk-open')
    const button = control.querySelector('button')!
    expect([button.type, button.textContent, button.tabIndex]).toEqual(['button', 'Open desk', 0])
    const note = control.querySelector<HTMLElement>('.desk-open-note')!
    expect([note.hidden, note.getAttribute('role'), note.textContent]).toEqual([true, 'status', ''])
    expect(opener.control(document, { session: SESSION })).toBeNull()
  })

  it('a click sends { session } and nothing else, never reaches what holds the button, and says Opened for 1.5 seconds', async () => {
    const desk = hubDesk()
    const opener = installDeskOpen({ desk: () => desk })
    await opener.ready()
    const card = document.createElement('article')
    const cardClick = vi.fn()
    card.addEventListener('click', cardClick)
    const control = opener.control(document, ROW)!
    card.append(control)
    document.body.append(card)
    const button = control.querySelector('button')!
    button.click()
    expect(button.disabled).toBe(true)
    await flush()
    expect(desk.open.mock.calls).toEqual([[{ session: SESSION }]])
    expect(cardClick).not.toHaveBeenCalled()
    expect([button.disabled, button.textContent]).toEqual([false, 'Opened'])
    await vi.advanceTimersByTimeAsync(1_499)
    expect(button.textContent).toBe('Opened')
    await vi.advanceTimersByTimeAsync(1)
    expect(button.textContent).toBe('Open desk')
  })

  it('shows the fallback notice with Opened when the terminal fell back', async () => {
    const desk = hubDesk()
    desk.open.mockResolvedValue({ ok: true, notice: 'iTerm2 could not be opened, so Terminal was opened instead.' })
    const opener = installDeskOpen({ desk: () => desk })
    await opener.ready()
    const control = opener.control(document, ROW)!
    control.querySelector('button')!.click()
    await flush()
    const note = control.querySelector<HTMLElement>('.desk-open-note')!
    expect([note.hidden, note.textContent]).toEqual([false, 'iTerm2 could not be opened, so Terminal was opened instead.'])
    await vi.advanceTimersByTimeAsync(1_500)
    expect([note.hidden, note.textContent]).toEqual([true, ''])
  })

  it.each([...Object.entries(DESK_REFUSALS), ['failed', DESK_FALLBACK], ['unavailable', DESK_FALLBACK], ['bad_request', DESK_FALLBACK]])(
    'says %s as one sentence beside the button for 6 seconds',
    async (reason, sentence) => {
      const desk = hubDesk()
      desk.open.mockResolvedValue({ ok: false, reason })
      const opener = installDeskOpen({ desk: () => desk })
      await opener.ready()
      const control = opener.control(document, ROW)!
      const button = control.querySelector('button')!
      const note = control.querySelector<HTMLElement>('.desk-open-note')!
      button.click()
      await flush()
      expect([button.textContent, button.disabled, note.hidden, note.textContent]).toEqual(['Open desk', false, false, sentence])
      await vi.advanceTimersByTimeAsync(5_999)
      expect(note.textContent).toBe(sentence)
      await vi.advanceTimersByTimeAsync(1)
      expect([note.hidden, note.textContent]).toEqual([true, ''])
    },
  )

  it('a bridge that throws reads as the fallback sentence', async () => {
    const desk = hubDesk()
    desk.open.mockRejectedValue(new Error('gone'))
    const opener = installDeskOpen({ desk: () => desk })
    await opener.ready()
    const control = opener.control(document, ROW)!
    control.querySelector('button')!.click()
    await flush()
    expect(control.querySelector('.desk-open-note')!.textContent).toBe(DESK_FALLBACK)
  })

  it('a newer answer is not cleared by an older one’s timer, and a disabled button sends nothing', async () => {
    const desk = hubDesk()
    desk.open.mockResolvedValueOnce({ ok: false, reason: 'busy' }).mockResolvedValueOnce({ ok: false, reason: 'no_desk' })
    const opener = installDeskOpen({ desk: () => desk })
    await opener.ready()
    const control = opener.control(document, ROW)!
    const button = control.querySelector('button')!
    const note = control.querySelector<HTMLElement>('.desk-open-note')!
    button.click()
    await flush()
    await vi.advanceTimersByTimeAsync(4_000)
    button.click()
    await flush()
    await vi.advanceTimersByTimeAsync(2_000)
    expect(note.textContent).toBe(DESK_REFUSALS.no_desk)
    button.disabled = true
    expect(await opener.run(SESSION, button, note)).toBeNull()
    expect(desk.open).toHaveBeenCalledTimes(2)
  })

  it('sets every word as text: a hostile notice is shown, never parsed', async () => {
    const desk = hubDesk()
    desk.open.mockResolvedValue({ ok: true, notice: '<img src=x onerror=alert(1)>' })
    const opener = installDeskOpen({ desk: () => desk })
    await opener.ready()
    const control = opener.control(document, ROW)!
    control.querySelector('button')!.click()
    await flush()
    expect(control.querySelector('img')).toBeNull()
    expect(control.querySelector('.desk-open-note')!.textContent).toBe('<img src=x onerror=alert(1)>')
  })
})
