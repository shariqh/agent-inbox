import { describe, it, expect } from 'vitest'
// Pure launcher decision logic for the Electron shell (issue #23). Kept in a
// dependency-free .cjs alongside main.cjs so the Electron main process can
// `require` it directly, while this ESM test exercises it in isolation.
import reuse from '../electron/reuse.cjs'

describe('confirmReuse — re-probe before committing to reuse', () => {
  const noSleep = async () => {}

  it('does not reuse when nothing answers the first probe (starts our own server)', async () => {
    let calls = 0
    const probe = async () => {
      calls++
      return false
    }
    expect(await reuse.confirmReuse(probe, noSleep, 10)).toBe(false)
    // Short-circuits: a failing first probe means no server, so don't waste a second probe.
    expect(calls).toBe(1)
  })

  it('reuses only when BOTH probes succeed (a healthy standing viewer)', async () => {
    let calls = 0
    const probe = async () => {
      calls++
      return true
    }
    expect(await reuse.confirmReuse(probe, noSleep, 10)).toBe(true)
    expect(calls).toBe(2)
  })

  describe('classifyReuse — fail closed on an unmarked listener', () => {
    const noSleep = async () => {}

    it('reports none when the port is free', async () => {
      expect(await reuse.classifyReuse(
        async () => false,
        async () => false,
        noSleep,
        10,
      )).toBe('none')
    })

    it('reuses only a compatible viewer that survives both probes', async () => {
      expect(await reuse.classifyReuse(
        async () => true,
        async () => true,
        noSleep,
        10,
      )).toBe('reuse')
    })

    it('starts its own viewer when a compatible upstream dies during confirmation', async () => {
      const compatible = [true, false]
      const present = [true, false]
      expect(await reuse.classifyReuse(
        async () => present.shift() ?? false,
        async () => compatible.shift() ?? false,
        noSleep,
        10,
      )).toBe('none')
    })

    it('refuses a persistent listener that does not attest the hardened boundary', async () => {
      expect(await reuse.classifyReuse(
        async () => true,
        async () => false,
        noSleep,
        10,
      )).toBe('incompatible')
    })

    it('starts its own viewer if an incompatible listener disappears during classification', async () => {
      const present = [true, false]
      expect(await reuse.classifyReuse(
        async () => present.shift() ?? false,
        async () => false,
        noSleep,
        10,
      )).toBe('none')
    })
  })

  it('does NOT reuse a DYING viewer that answers once then vanishes (the #23 race)', async () => {
    const results = [true, false] // alive for probe 1, gone by probe 2
    let i = 0
    const probe = async () => results[i++] ?? false
    expect(await reuse.confirmReuse(probe, noSleep, 10)).toBe(false)
  })
})

describe('watchUpstream — self-heal if a reused viewer disappears', () => {
  function manualScheduler() {
    let cb: (() => unknown) | null = null
    return {
      setIntervalFn: (fn: () => unknown) => {
        cb = fn
        return 1
      },
      clearIntervalFn: () => {
        cb = null
      },
      tick: async () => {
        if (cb) await cb()
      },
      get active() {
        return cb !== null
      },
    }
  }

  it('heals exactly once after N consecutive failed probes, then stops watching', async () => {
    const sched = manualScheduler()
    let healed = 0
    const results = [true, false, false] // alive, then gone for good
    let i = 0
    const probe = async () => results[i++] ?? false
    reuse.watchUpstream(
      probe,
      () => {
        healed++
      },
      { failuresToHeal: 2, setIntervalFn: sched.setIntervalFn, clearIntervalFn: sched.clearIntervalFn },
    )
    await sched.tick() // alive → no heal
    expect(healed).toBe(0)
    await sched.tick() // fail 1 → no heal yet
    expect(healed).toBe(0)
    await sched.tick() // fail 2 → heal
    expect(healed).toBe(1)
    expect(sched.active).toBe(false) // stopped after healing
    await sched.tick() // further ticks are no-ops
    expect(healed).toBe(1)
  })

  it('resets the failure count on recovery — a transient blip does not heal', async () => {
    const sched = manualScheduler()
    let healed = 0
    const results = [false, true, false] // blip, recover, blip
    let i = 0
    const probe = async () => results[i++] ?? true
    reuse.watchUpstream(
      probe,
      () => {
        healed++
      },
      { failuresToHeal: 2, setIntervalFn: sched.setIntervalFn, clearIntervalFn: sched.clearIntervalFn },
    )
    await sched.tick() // fail 1
    await sched.tick() // recover → reset
    await sched.tick() // fail 1 again (not 2 consecutive)
    expect(healed).toBe(0)
  })

  it('stop() cancels the watch', () => {
    const sched = manualScheduler()
    const stop = reuse.watchUpstream(async () => true, () => {}, {
      setIntervalFn: sched.setIntervalFn,
      clearIntervalFn: sched.clearIntervalFn,
    })
    expect(sched.active).toBe(true)
    stop()
    expect(sched.active).toBe(false)
  })
})
