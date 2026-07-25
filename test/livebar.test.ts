import { describe, it, expect } from 'vitest'
import { liveSummary } from '../public/livebar.js'

const NOW = Date.parse('2026-07-24T12:00:00.000Z')
const at = (msAgo: number) => new Date(NOW - msAgo).toISOString()
const sess = (o: Partial<Record<string, unknown>> = {}) => ({
  session: 's1', project: 'oris', agent: 'claude-code', stream: '', doing: 'working',
  detail: '', children: [], idle: false, updated_at: at(1000), started_at: at(60_000), ...o,
})

describe('liveSummary', () => {
  it('counts only non-idle sessions and labels them project/agent', () => {
    const s = liveSummary([sess(), sess({ session: 's2', project: 'api', idle: true })], NOW)
    expect(s.count).toBe(1)
    expect(s.label).toBe('1 working')
    expect(s.sessions).toEqual([{ session: 's1', label: 'oris/claude-code', tone: 'fresh' }])
  })

  it('pluralises', () => {
    const s = liveSummary([sess(), sess({ session: 's2', project: 'api' })], NOW)
    expect(s.label).toBe('2 working')
  })

  it('reads idle when nothing is running — the strip still renders', () => {
    const s = liveSummary([sess({ idle: true })], NOW)
    expect(s.count).toBe(0)
    expect(s.tone).toBe('idle')
    expect(s.label).toBe('no agents running')
    expect(s.sessions).toEqual([])
  })

  it('empty activity is idle, never a crash', () => {
    expect(liveSummary([], NOW).label).toBe('no agents running')
    expect(liveSummary(undefined as never, NOW).label).toBe('no agents running')
  })

  it('strip tone is the FRESHEST session — one live agent must not read as quiet', () => {
    const s = liveSummary([sess({ updated_at: at(10 * 60_000) }), sess({ session: 's2', updated_at: at(500) })], NOW)
    expect(s.tone).toBe('fresh')
  })

  it('per-session tones use the shared freshness scale', () => {
    const s = liveSummary([
      sess({ session: 'a', updated_at: at(500) }),
      sess({ session: 'b', updated_at: at(2 * 60_000) }),
      sess({ session: 'c', updated_at: at(30 * 60_000) }),
    ], NOW)
    expect(s.sessions.map((x) => x.tone)).toEqual(['fresh', 'aging', 'quiet'])
  })
})
