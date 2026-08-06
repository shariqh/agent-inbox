// test/layout.test.ts
import { describe, it, expect } from 'vitest'
import { layoutMode, railLabel, NARROW_MAX } from '../public/layout.js'
import { projectMonogram } from '../public/colors.js'

describe('layoutMode', () => {
  it('switches before three panes can crush the queue', () => {
    expect(NARROW_MAX).toBe(1279)
  })
  it('is wide above the breakpoint', () => {
    expect(layoutMode(1400)).toBe('wide')
    expect(layoutMode(1280)).toBe('wide')
  })
  it('is narrow at and below the breakpoint', () => {
    expect(layoutMode(NARROW_MAX)).toBe('narrow')
    expect(layoutMode(480)).toBe('narrow')
  })
})

describe('railLabel', () => {
  it('is the full project name when wide', () => {
    expect(railLabel('agent-inbox', 'wide')).toBe('agent-inbox')
  })
  it('collapses to the monogram in the narrow dot column', () => {
    expect(railLabel('agent-inbox', 'narrow')).toBe(projectMonogram('agent-inbox'))
    expect(railLabel('agent-inbox', 'narrow').length).toBeLessThanOrEqual(2)
  })
  it('keeps the All and unknown pseudo-projects labelled', () => {
    expect(railLabel('All', 'wide')).toBe('All')
    expect(railLabel('All', 'narrow')).toBe(projectMonogram('All'))
    expect(railLabel('unknown', 'narrow')).toBe(projectMonogram('unknown'))
  })
})
