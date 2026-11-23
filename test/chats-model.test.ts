// test/chats-model.test.ts — the Chats tab's pure model (#586 PR 2): the resume
// command's quoting, the sort, search and filters, the home folder as ~, labels
// and the fetch rule; and (#586 phase 2) Continue here…'s eligibility, a chat's
// link to a launch of this app, and main's answer in the row. Fixtures are synthetic.
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import {
  allSwitchText, chatLaunch, chatsUrl, continueControl, continueOutcome, displayFolder, drivenView, emptyText, filterChats,
  hiddenLabel, inferHome, isChatsHash, JUMP_GONE_TEXT, JUMP_LABEL, jumpControl, lastActiveView, projectOptions, readChatsBody, resumeCommand, resumeControl, resumeOutcome,
  resumeTerminalControl, retentionText, shouldFetchOnOpen, shownText, sortChats, titleView, toolLabel, TRUNCATED_TEXT,
} from '../public/chats.js'
import chatResume from '../electron/chat-resume.cjs'
import type { Chat, ChatFilter } from '../public/chats.js'
import { removeScratchDirs, scratchDir } from './scratch.js'

const ID = '00000000-0000-4000-8000-000000000001'
const ID2 = '00000000-0000-4000-8000-000000000002'

function chat(over: Partial<Chat> = {}): Chat {
  return {
    id: ID, tool: 'claude', title: 'Fix the parser', titleAuto: false, project: 'alpha',
    cwd: '/Users/tester/dev/alpha', branch: 'main', createdAt: '2026-07-20T09:00:00.000Z',
    lastActiveAt: '2026-07-20T09:55:00.000Z', live: false, pr: null, hidden: [], ...over,
  }
}

const all: ChatFilter = { query: '', tool: 'all', project: null }

afterEach(() => removeScratchDirs())

describe('chats model (#586 PR 2)', () => {
  describe('resumeCommand', () => {
    it('builds each tool’s command in the chat’s folder', () => {
      expect(resumeCommand(chat())).toBe(`cd '/Users/tester/dev/alpha' && claude --resume ${ID}`)
      expect(resumeCommand(chat({ tool: 'copilot' }))).toBe(`cd '/Users/tester/dev/alpha' && copilot --resume=${ID}`)
    })

    it('single-quotes spaces, quotes, $() and backticks literally', () => {
      expect(resumeCommand(chat({ cwd: '/Users/tester/my dev' }))).toBe(`cd '/Users/tester/my dev' && claude --resume ${ID}`)
      expect(resumeCommand(chat({ cwd: "/Users/tester/it's" }))).toBe(`cd '/Users/tester/it'\\''s' && claude --resume ${ID}`)
      expect(resumeCommand(chat({ cwd: '/Users/tester/$(rm -rf ~)' }))).toBe(`cd '/Users/tester/$(rm -rf ~)' && claude --resume ${ID}`)
      expect(resumeCommand(chat({ cwd: '/Users/tester/`id`' }))).toBe(`cd '/Users/tester/\`id\`' && claude --resume ${ID}`)
      expect(resumeCommand(chat({ cwd: "/a/'$(x)'/b" }))).toBe(`cd '/a/'\\''$(x)'\\''/b' && claude --resume ${ID}`)
      expect(resumeCommand(chat({ cwd: '/a/-n x' }))).toBe(`cd '/a/-n x' && claude --resume ${ID}`)
    })

    it('refuses a folder with a line break or another control character', () => {
      for (const bad of ['/a\nb', '/a\rb', '/a\u0000b', '/a\u2028b', '/a\u2029b', '/a\u009bb', '/a\u007fb', '/a\tb']) {
        expect(resumeCommand(chat({ cwd: bad })), JSON.stringify(bad)).toBeNull()
      }
    })

    it('refuses a relative, empty or missing folder', () => {
      for (const cwd of ['dev/alpha', '', '~/dev', null]) expect(resumeCommand(chat({ cwd })), String(cwd)).toBeNull()
    })

    it('refuses an id that is not a lowercase UUID, and an unknown tool', () => {
      expect(resumeCommand(chat({ id: '0000000a-0000-4000-8000-00000000000b' }))).not.toBeNull()
      for (const id of ['abc', '0000000A-0000-4000-8000-00000000000B', `${ID}; ls`, `${ID}\n`, ` ${ID}`, '']) {
        expect(resumeCommand(chat({ id })), JSON.stringify(id)).toBeNull()
      }
      expect(resumeCommand(chat({ tool: 'gemini' }))).toBeNull()
    })

    it('round-trips each hostile folder through /bin/sh to the same path', () => {
      const root = realpathSync(scratchDir('chats-quote-'))
      for (const name of ['my dev', "it's", '$(touch pwned)', '`touch pwned`', '-n x', "a'b'c", 'dollar $HOME', 'semi;colon && x']) {
        const folder = join(root, name)
        mkdirSync(folder)
        const command = resumeCommand(chat({ cwd: folder }))
        expect(command, name).not.toBeNull()
        const probe = command!.replace(` && claude --resume ${ID}`, ' && pwd')
        expect(execFileSync('/bin/sh', ['-c', probe], { encoding: 'utf8', cwd: root }).trimEnd(), name).toBe(folder)
      }
      // nothing in a folder name ran
      expect(() => execFileSync('/bin/ls', [join(root, 'pwned')], { stdio: 'ignore' })).toThrow()
    })
  })

  describe('resumeControl', () => {
    it('gives the missing-folder reason for a null cwd, which the index also marks folder-gone', () => {
      expect(resumeControl(chat({ cwd: null, hidden: ['folder-gone'] })))
        .toEqual({ command: null, title: "The chat's files name no folder to resume in." })
    })

    it('gives the folder-gone reason for a deleted folder', () => {
      expect(resumeControl(chat({ hidden: ['folder-gone'] })))
        .toEqual({ command: null, title: "The chat's folder no longer exists, so it cannot be resumed there." })
    })

    it('gives the unsafe reason for a bad id', () => {
      expect(resumeControl(chat({ id: 'abc' })).command).toBeNull()
      expect(resumeControl(chat({ id: 'abc' })).title).toBe("This chat's id or folder can't be made into a safe command.")
    })

    it('keeps the command as the first title line and warns about a live chat on the second', () => {
      const ready = resumeControl(chat())
      expect(ready.title).toBe(ready.command)
      const live = resumeControl(chat({ live: true }))
      expect(live.command).toBe(resumeCommand(chat()))
      expect(live.title.split('\n')).toEqual([live.command, 'This chat is live in another process; resuming it opens a second copy.'])
    })
  })

  it('sorts newest first, no time last, ties by id, without mutating', () => {
    const input = [
      chat({ id: 'c', lastActiveAt: null }),
      chat({ id: 'b', lastActiveAt: '2026-07-20T08:00:00.000Z' }),
      chat({ id: 'a', lastActiveAt: '2026-07-20T09:00:00.000Z' }),
      chat({ id: 'd', lastActiveAt: '2026-07-20T08:00:00.000Z' }),
      chat({ id: 'e', lastActiveAt: 'not a date' }),
    ]
    const copy = [...input]
    expect(sortChats(input).map((c) => c.id)).toEqual(['a', 'b', 'd', 'c', 'e'])
    expect(input).toEqual(copy)
  })

  describe('filterChats', () => {
    const home = '/Users/tester'
    const list = [
      chat({ id: '1', title: 'Parser work', project: 'alpha', branch: 'feat/lexer', cwd: '/Users/tester/dev/alpha' }),
      chat({ id: '2', tool: 'copilot', title: null, project: 'beta', branch: null, cwd: '/Users/tester/dev/beta' }),
      chat({ id: '3', tool: 'copilot', title: 'Beta docs', project: 'alpha', branch: 'docs', cwd: null }),
      chat({ id: '4', title: 'Release', project: 'gamma', branch: 'main', cwd: '/opt/gamma' }),
    ]
    const ids = (filter: Partial<ChatFilter>) => filterChats(list, { ...all, ...filter }, home).map((c) => c.id)

    it('searches title, project, branch, the folder and its ~ form, case-insensitively and trimmed', () => {
      expect(ids({ query: 'PARSER' })).toEqual(['1'])
      expect(ids({ query: '  beta ' })).toEqual(['2', '3'])
      expect(ids({ query: 'lexer' })).toEqual(['1'])
      expect(ids({ query: '/opt/' })).toEqual(['4'])
      expect(ids({ query: '~/dev' })).toEqual(['1', '2'])
      expect(ids({ query: '/users/tester/dev/b' })).toEqual(['2'])
    })

    it('narrows by tool and by project, and intersects them with the search', () => {
      expect(ids({ tool: 'copilot' })).toEqual(['2', '3'])
      expect(ids({ project: 'alpha' })).toEqual(['1', '3'])
      expect(ids({ tool: 'copilot', project: 'alpha' })).toEqual(['3'])
      expect(ids({ query: 'beta', tool: 'copilot', project: 'alpha' })).toEqual(['3'])
      expect(ids({ query: 'nothing here' })).toEqual([])
    })

    it('returns everything for an empty search and no filters', () => {
      expect(ids({})).toEqual(['1', '2', '3', '4'])
    })
  })

  it('lists each project once, sorted', () => {
    expect(projectOptions([chat({ project: 'beta' }), chat({ project: 'alpha' }), chat({ project: 'beta' })])).toEqual(['alpha', 'beta'])
  })

  describe('home folder', () => {
    it('infers the one home every chat folder shares', () => {
      expect(inferHome([chat(), chat({ cwd: '/Users/tester' }), chat({ cwd: null }), chat({ cwd: '/private/tmp/x' })])).toBe('/Users/tester')
      expect(inferHome([chat({ cwd: '/home/tester/x' })])).toBe('/home/tester')
    })

    it('infers none for two users, the shared folder or only temp folders', () => {
      expect(inferHome([chat(), chat({ cwd: '/Users/other/dev' })])).toBeNull()
      expect(inferHome([chat({ cwd: '/Users/Shared/x' })])).toBeNull()
      expect(inferHome([chat({ cwd: '/private/tmp/x' }), chat({ cwd: '/var/folders/y' })])).toBeNull()
    })

    it('shows the home folder as ~ only on a whole segment', () => {
      const home = '/Users/tester'
      expect(displayFolder('/Users/tester', home)).toBe('~')
      expect(displayFolder('/Users/tester/x', home)).toBe('~/x')
      expect(displayFolder('/Users/testerx/y', home)).toBe('/Users/testerx/y')
      expect(displayFolder('/Users/tester/x', null)).toBe('/Users/tester/x')
      expect(displayFolder(null, home)).toBe('')
    })
  })

  it('shows an automatic or missing title quietly', () => {
    expect(titleView({ title: null, titleAuto: false })).toEqual({ text: 'Untitled', quiet: true, title: null })
    expect(titleView({ title: 'how do I', titleAuto: true }))
      .toEqual({ text: 'how do I', quiet: true, title: "Copilot's automatic name: the opening of the chat's first prompt" })
    expect(titleView({ title: 'Named', titleAuto: false })).toEqual({ text: 'Named', quiet: false, title: null })
  })

  it('shows last active relative, with the exact time as its title', () => {
    const now = Date.parse('2026-07-20T10:00:00.000Z')
    const five = lastActiveView('2026-07-20T09:55:00.000Z', now)
    expect(five.text).toBe('5m ago')
    expect(five.title).toBe(new Date('2026-07-20T09:55:00.000Z').toLocaleString())
    expect(lastActiveView('2026-07-20T09:59:30.000Z', now).text).toBe('just now')
    expect(lastActiveView('2026-07-17T10:00:00.000Z', now).text).toBe('3d ago')
    expect(lastActiveView(null, now)).toEqual({ text: '—', title: 'No activity recorded' })
  })

  describe('readChatsBody', () => {
    it('reads a valid body', () => {
      const body = readChatsBody({
        chats: [chat()], counts: { total: 3, hidden: 2, claude: 2, copilot: 1, live: 0 }, truncated: true, retention: { claudeDays: 21 },
      })
      expect(body).toEqual({ chats: [chat()], counts: { total: 3, hidden: 2, claude: 2, copilot: 1, live: 0 }, truncated: true, claudeDays: 21 })
    })

    it('shows no branch for HEAD: a folder that is not a repository, or a detached checkout', () => {
      const body = readChatsBody({ chats: [chat({ branch: 'HEAD' }), chat({ id: ID2, branch: 'feat/HEAD-fix' })] })
      expect(body?.chats.map((c) => c.branch)).toEqual([null, 'feat/HEAD-fix'])
    })

    it('refuses a body without a chat list and drops malformed entries', () => {
      expect(readChatsBody({ chats: 'x' })).toBeNull()
      expect(readChatsBody(null)).toBeNull()
      const body = readChatsBody({ chats: [null, 7, { tool: 'claude' }, { id: 5, tool: 'claude' }, { id: ID2, tool: 'copilot' }] })
      expect(body?.chats.map((c) => c.id)).toEqual([ID2])
      expect(body?.chats[0]).toMatchObject({ title: null, cwd: null, hidden: [], live: false, pr: null, project: '' })
      expect(body?.claudeDays).toBe(30)
      expect(body?.truncated).toBe(false)
    })
  })

  it('labels the tools and the hidden reasons', () => {
    expect([toolLabel('claude'), toolLabel('copilot'), toolLabel('other')]).toEqual(['Claude Code', 'Copilot', 'other'])
    expect(['temp', 'non-interactive', 'empty', 'folder-gone', 'odd'].map(hiddenLabel))
      .toEqual(['Temp folder', 'Non-interactive', 'Empty', 'Folder gone', 'odd'])
  })

  it('states the counts, the switch, the empty states and the notes', () => {
    expect(allSwitchText({ total: 1500, hidden: 1472, claude: 1, copilot: 1, live: 0 })).toBe('Show all (1,472 hidden)')
    expect(allSwitchText({ total: 3, hidden: 0, claude: 1, copilot: 1, live: 0 })).toBe('Show all')
    expect(allSwitchText(null)).toBe('Show all')
    expect(shownText(71, 71)).toBe('71 chats')
    expect(shownText(1, 1)).toBe('1 chat')
    expect(shownText(3, 71)).toBe('Showing 3 of 71 chats')
    expect(emptyText({ loaded: 0, shown: 0, hidden: 0, all: false })).toBe('No chats found.')
    expect(emptyText({ loaded: 0, shown: 0, hidden: 2, all: false })).toBe('No chats found. 2 hidden chats: turn on Show all.')
    expect(emptyText({ loaded: 0, shown: 0, hidden: 2, all: true })).toBe('No chats found.')
    expect(emptyText({ loaded: 4, shown: 0, hidden: 0, all: false })).toBe('No chats match the search and filters.')
    expect(emptyText({ loaded: 4, shown: 2, hidden: 0, all: false })).toBeNull()
    expect(retentionText(21)).toBe('Claude Code deletes chats that have been untouched for 21 days. Agent Inbox does not copy them.')
    expect(TRUNCATED_TEXT).toContain('incomplete')
  })

  it('reads on open only when nothing is loaded or the list is over a minute old', () => {
    expect(shouldFetchOnOpen({ loadedAt: null, loading: false, nowMs: 0 })).toBe(true)
    expect(shouldFetchOnOpen({ loadedAt: 0, loading: false, nowMs: 30_000 })).toBe(false)
    expect(shouldFetchOnOpen({ loadedAt: 0, loading: false, nowMs: 61_000 })).toBe(true)
    expect(shouldFetchOnOpen({ loadedAt: null, loading: true, nowMs: 0 })).toBe(false)
  })

  it('names the deep link and the two reads', () => {
    expect([isChatsHash('#chats'), isChatsHash('chats'), isChatsHash('#item/x'), isChatsHash(undefined)]).toEqual([true, true, false, false])
    expect([chatsUrl(false), chatsUrl(true)]).toEqual(['/api/chats', '/api/chats?all=1'])
  })

  describe('Resume in Terminal (#586 PR 3)', () => {
    it('is on with a title naming the app, and an aria-label only for iTerm2', () => {
      expect(resumeTerminalControl(chat(), 'terminal')).toEqual({ enabled: true, title: 'Resume in Terminal', ariaLabel: null })
      expect(resumeTerminalControl(chat(), 'iterm2')).toEqual({ enabled: true, title: 'Resume in iTerm2', ariaLabel: 'Resume in iTerm2' })
      expect(resumeTerminalControl(chat(), 'Hyper')).toEqual({ enabled: true, title: 'Resume in Terminal', ariaLabel: null })
    })

    it.each([
      ['no folder', { cwd: null, hidden: ['folder-gone'] }, "The chat's files name no folder to resume in."],
      ['a folder that is gone', { hidden: ['folder-gone'] }, "The chat's folder no longer exists, so it cannot be resumed there."],
      ['a live chat', { live: true }, 'This chat is live in another process, so it is not resumed a second time.'],
      ['a live chat whose folder is gone', { live: true, hidden: ['folder-gone'] }, 'This chat is live in another process, so it is not resumed a second time.'],
      ['an id that is not a UUID', { id: '--help' }, "This chat's id or folder can't be made into a safe command."],
      ['a folder with a newline', { cwd: '/Users/tester/a\nb' }, "This chat's id or folder can't be made into a safe command."],
    ] as Array<[string, Partial<Chat>, string]>)('is off for %s, with the reason as its title', (_, over, title) => {
      expect(resumeTerminalControl(chat(over), 'iterm2')).toEqual({ enabled: false, title, ariaLabel: null })
    })

    it('reads main’s answer into a label, a note and whether to read the list again', () => {
      expect(resumeOutcome({ ok: true, terminal: 'iterm2' })).toEqual({ label: 'Opened in iTerm2', note: null, refresh: false })
      const notice = 'iTerm2 could not be opened, so Terminal was opened instead.'
      expect(resumeOutcome({ ok: true, terminal: 'terminal', notice })).toEqual({ label: 'Opened in Terminal', note: notice, refresh: false })
      for (const reason of ['live', 'folder', 'missing', 'opened']) {
        expect(resumeOutcome({ ok: false, reason, error: `because ${reason}` })).toEqual({ label: null, note: `because ${reason}`, refresh: true })
      }
      for (const reason of ['open', 'busy', 'write', 'invalid', 'unavailable']) {
        expect(resumeOutcome({ ok: false, reason, error: 'x' })).toMatchObject({ label: null, refresh: false })
      }
      expect(resumeOutcome({ ok: false, reason: 'open' })).toEqual({ label: null, note: 'Could not resume this chat.', refresh: false })
      expect(resumeOutcome(null)).toEqual({ label: null, note: 'Could not resume this chat.', refresh: false })
    })

    it.each([
      '/Users/tester/dev/alpha', "/Users/tester/it's here", '/Users/tester/say "hi"', '/Users/tester/$(touch pwned)',
      '/Users/tester/`id`', '/Users/tester/a; b', "/Users/tester/''",
    ])('runs exactly the command Copy resume copies, in %s', (cwd) => {
      for (const tool of ['claude', 'copilot']) {
        const copied = resumeCommand({ id: ID, tool, cwd })!
        const lines = chatResume.chatResumeScript({ tool, id: ID, cwd })!.split('\n')
        const cd = /^cd -- (.*) \|\| exit 1$/.exec(lines[2]!)![1]
        expect(lines[3]!.startsWith('exec ')).toBe(true)
        expect(`cd ${cd} && ${lines[3]!.slice('exec '.length)}`).toBe(copied)
      }
    })
  })

  // #586 phase 2 (design §3.1, §3.5, §3.6): Continue here…, and a chat's link to a launch of this app
  describe('continueControl', () => {
    const copilot = (over: Partial<Chat> = {}) => chat({ tool: 'copilot', ...over })

    it('is drawn only on a Copilot row, on by default, with its title', () => {
      expect(continueControl(chat())).toBeNull()
      expect(continueControl(chat({ tool: 'gemini' }))).toBeNull()
      expect(continueControl(copilot())).toEqual({ enabled: true, title: 'Continue this chat in Agent Inbox, as a session it drives' })
      // temp is a list filter, never a refusal
      expect(continueControl(copilot({ hidden: ['temp'] }))!.enabled).toBe(true)
    })

    it.each<[string, Partial<Chat>, string]>([
      ['live', { live: true }, 'This chat is live in another process, so it is not continued a second time.'],
      ['folder-gone', { hidden: ['folder-gone'] }, 'Its folder no longer exists.'],
      ['no folder', { cwd: null, hidden: ['folder-gone'] }, 'Its folder no longer exists.'],
      ['empty', { hidden: ['empty'] }, 'Nothing was ever said in this chat.'],
      ['non-interactive', { hidden: ['non-interactive'] }, 'This was not an interactive chat.'],
      ['an id that is not a UUID', { id: 'abc' }, 'This chat can’t be continued here.'],
    ])('is off for %s, with the reason as its title', (_name, over, title) => {
      expect(continueControl(copilot(over))).toEqual({ enabled: false, title })
    })

    it('names the first reason in the design’s order: live, folder, empty, non-interactive', () => {
      expect(continueControl(copilot({ live: true, hidden: ['folder-gone', 'empty'] }))!.title).toMatch(/live/)
      expect(continueControl(copilot({ hidden: ['non-interactive', 'empty', 'folder-gone'] }))!.title).toBe('Its folder no longer exists.')
      expect(continueControl(copilot({ hidden: ['non-interactive', 'empty'] }))!.title).toBe('Nothing was ever said in this chat.')
    })
  })

  describe('chatLaunch and drivenView', () => {
    const L1 = '11111111-2222-4333-8444-000000000001'
    const L2 = '11111111-2222-4333-8444-000000000002'
    const L3 = '11111111-2222-4333-8444-000000000003'
    const launch = (id: string, over: Record<string, unknown> = {}) => ({
      id, chat_id: ID, status: 'running', end_reason: null, resumable: false, created_at: '2026-07-20T09:00:00.000Z', ...over,
    })

    it('finds the launch whose chat_id is the chat, and none for another chat or no list', () => {
      const one = launch(L1)
      expect(chatLaunch([one], ID)).toBe(one)
      expect(chatLaunch([one], ID2)).toBeNull()
      expect(chatLaunch([launch(L2, { chat_id: null }), launch(L3, { chat_id: undefined })], ID)).toBeNull()
      expect(chatLaunch(null, ID)).toBeNull()
      expect(chatLaunch([null, 'x', { chat_id: ID }] as never, ID)).toBeNull()
    })

    it('prefers the launch that holds the chat, then the newest', () => {
      const failed = launch(L1, { status: 'ended', end_reason: 'error:start', created_at: '2026-07-20T10:00:00.000Z' })
      const parked = launch(L2, { status: 'parked', created_at: '2026-07-20T09:00:00.000Z' })
      expect(chatLaunch([failed, parked], ID)).toBe(parked)
      expect(chatLaunch([parked, failed], ID)).toBe(parked)
      const older = launch(L3, { status: 'ended', end_reason: 'handed_off', created_at: '2026-07-20T08:00:00.000Z' })
      expect(chatLaunch([older, failed], ID)).toBe(failed)
    })

    it.each<[string, Record<string, unknown>, { show: boolean; here: boolean }]>([
      ['running', { status: 'running' }, { show: true, here: true }],
      ['parked', { status: 'parked' }, { show: true, here: false }],
      ['stopped with its session', { status: 'ended', end_reason: 'stopped', resumable: true }, { show: true, here: false }],
      ['ended by a budget with its session', { status: 'ended', end_reason: 'budget:tool_calls', resumable: true }, { show: true, here: false }],
      ['stopped before its first message', { status: 'ended', end_reason: 'stopped', resumable: false }, { show: false, here: false }],
      ['handed off', { status: 'ended', end_reason: 'handed_off', resumable: true }, { show: false, here: false }],
      ['ended in an error', { status: 'ended', end_reason: 'error:load', resumable: false }, { show: false, here: false }],
    ])('a %s launch gives Show session and "· here" as the design says', (_name, over, want) => {
      const row = launch(L1, over)
      const view = drivenView(row)
      expect({ show: view.show !== null, here: view.here }).toEqual(want)
      if (want.show) {
        expect(view).toMatchObject({ show: L1, offTitle: 'This chat has a session here: use Show session, then Take over.' })
      }
      // the page's rule agrees with main's, which refuses Resume in Terminal and Continue here…
      expect(view.show !== null).toBe(chatResume.holdsChat(row))
    })

    it('changes nothing for no launch', () => {
      expect(drivenView(null)).toEqual({ show: null, here: false, title: null, hereTitle: null, offTitle: null })
    })
  })

  describe('Jump to session', () => {
    const SESSION = '11111111-2222-4333-8444-555555555555'

    it('is for a live chat the list named a session for, on either tool', () => {
      expect(JUMP_LABEL).toBe('Jump to session')
      expect(jumpControl(chat({ live: true, session: SESSION }))).toEqual({ session: SESSION, title: 'Open this chat’s session on Home' })
      expect(jumpControl(chat({ tool: 'copilot', live: true, session: SESSION }))?.session).toBe(SESSION)
    })

    it('is none for a chat that is not live, or a live one with no session', () => {
      expect(jumpControl(chat({ live: false, session: SESSION }))).toBeNull()
      expect(jumpControl(chat({ live: true }))).toBeNull()
      expect(jumpControl(chat({ live: true, session: '' }))).toBeNull()
      expect(jumpControl(chat({ live: true, session: 7 as unknown as string }))).toBeNull()
    })

    it('reads a session from the list only as a string on a live chat, and adds no key otherwise', () => {
      const entry = (over: object) => ({ ...chat(), ...over })
      const body = readChatsBody({ chats: [
        entry({ id: ID, live: true, session: SESSION }),
        entry({ id: ID2, live: false, session: SESSION }),
        entry({ id: '00000000-0000-4000-8000-000000000003', live: true, session: { id: SESSION } }),
        entry({ id: '00000000-0000-4000-8000-000000000004', live: true, session: '' }),
      ] })!
      expect(body.chats.map((c) => c.session)).toEqual([SESSION, undefined, undefined, undefined])
      expect(body.chats.filter((c) => 'session' in c).map((c) => c.id)).toEqual([ID])
    })

    it('says a session that is gone is no longer listed', () => {
      expect(JUMP_GONE_TEXT).toBe('This chat’s session is no longer listed.')
    })
  })

  describe('continueOutcome', () => {
    it('puts main’s refusal in the note, and reads the list again after live, driven, folder or missing', () => {
      for (const reason of ['live', 'driven', 'folder', 'missing']) {
        expect(continueOutcome({ ok: false, reason, error: `because ${reason}` })).toEqual({ note: `because ${reason}`, refresh: true })
      }
      for (const reason of ['busy', 'index', 'kind', 'worktree', 'copilot_home', 'outdated', 'sessions', 'invalid', undefined]) {
        expect(continueOutcome({ ok: false, reason, error: 'x' })).toEqual({ note: 'x', refresh: false })
      }
      expect(continueOutcome(null)).toEqual({ note: 'This chat was not continued.', refresh: false })
    })

    it('shows nothing for a start or a cancelled confirmation', () => {
      expect(continueOutcome({ ok: true, launch: 'x' })).toEqual({ note: null, refresh: false })
      expect(continueOutcome({ ok: false, cancelled: true, error: 'Not continued.' })).toEqual({ note: null, refresh: false })
    })
  })
})
