// test/layout.test.ts
import { describe, it, expect } from 'vitest'
import { layoutMode, railLabel, NARROW_MAX } from '../public/layout.js'

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
  it('turns project slugs into readable labels in the compact project strip', () => {
    expect(railLabel('agent-inbox', 'narrow')).toBe('agent inbox')
    expect(railLabel('github_enterprise-settings', 'narrow')).toBe('github enterprise settings')
  })
  it('keeps the All and unknown pseudo-projects labelled', () => {
    expect(railLabel('All', 'wide')).toBe('All')
    expect(railLabel('All', 'narrow')).toBe('All')
    expect(railLabel('unknown', 'narrow')).toBe('unknown')
  })
})
