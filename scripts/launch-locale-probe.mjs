#!/usr/bin/env node
// Launch evidence for #292. Only US and British English ship, so the CI launch
// gates start the provisional app as a French and as a British user. This asks
// the running window, over Chromium's DevTools endpoint (the app is started
// with --remote-debugging-port), which locale its page runs in and how it
// formats the two dates the app formats with the default locale: the update
// check's "Last checked" and the asked-at tooltip. It fails unless that is the
// expected locale.
//
// usage: launch-locale-probe.mjs --devtools-port <n> --viewer-port <n> --expect <en-US|en-GB>
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

export class LaunchLocaleError extends Error {
  constructor(message) {
    super(message)
    this.name = 'LaunchLocaleError'
  }
}

// One fixed instant, formatted as app.js formats "Last checked" and as
// rowview.js formats the asked-at tooltip, in UTC so the runner's time zone
// does not matter.
export const PROBE = `(() => {
  const at = new Date(Date.UTC(2026, 9, 23, 14, 5, 6))
  return JSON.stringify({
    language: navigator.language,
    intl: Intl.DateTimeFormat().resolvedOptions().locale,
    lastChecked: at.toLocaleString(undefined, { timeZone: 'UTC' }),
    askedAt: new Intl.DateTimeFormat(undefined, {
      year: 'numeric', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit',
      timeZoneName: 'short', timeZone: 'UTC',
    }).format(at),
  })
})()`

export const EXPECTED = Object.freeze({
  'en-US': Object.freeze({
    language: 'en-US', intl: 'en-US', lastChecked: '10/23/2026, 2:05:06 PM', askedAt: 'Oct 23, 2026, 2:05:06 PM UTC',
  }),
  'en-GB': Object.freeze({
    language: 'en-GB', intl: 'en-GB', lastChecked: '23/10/2026, 14:05:06', askedAt: '23 Oct 2026, 14:05:06 UTC',
  }),
})

// ICU may put a narrow or non-breaking space before AM/PM.
const normalize = (value) => (typeof value === 'string' ? value.replace(/[\u00a0\u202f]/g, ' ') : value)

export function localeMismatches(observed, expected) {
  return Object.entries(expected)
    .filter(([key, value]) => normalize(observed?.[key]) !== value)
    .map(([key, value]) => `${key} is ${JSON.stringify(observed?.[key])}, not ${JSON.stringify(value)}`)
}

export function viewerPage(targets, viewerPort) {
  if (!Array.isArray(targets)) return undefined
  return targets.find((target) => target?.type === 'page'
    && typeof target.url === 'string' && target.url.startsWith(`http://127.0.0.1:${viewerPort}/`)
    && typeof target.webSocketDebuggerUrl === 'string')
}

function evaluate(webSocketUrl, expression, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const socket = new WebSocket(webSocketUrl)
    const fail = (message) => {
      clearTimeout(timer)
      socket.close()
      rejectPromise(new LaunchLocaleError(message))
    }
    const timer = setTimeout(() => fail(`no answer from ${webSocketUrl} within ${timeoutMs} ms`), timeoutMs)
    socket.addEventListener('error', () => fail(`could not talk to ${webSocketUrl}`))
    socket.addEventListener('open', () => {
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    })
    socket.addEventListener('message', (event) => {
      let reply
      try {
        reply = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (reply.id !== 1) return
      const value = reply.result?.result?.value
      if (typeof value !== 'string') {
        fail(`the page did not evaluate the probe: ${JSON.stringify(reply.error ?? reply.result?.exceptionDetails ?? reply)}`)
        return
      }
      clearTimeout(timer)
      socket.close()
      resolvePromise(value)
    })
  })
}

/**
 * Wait for the viewer page, evaluate PROBE in it and require the expected
 * locale. Returns what the page reported.
 */
export async function probeLaunchLocale({ devtoolsPort, viewerPort, expect, attempts = 30, intervalMs = 1000, timeoutMs = 10_000 }) {
  const expected = EXPECTED[expect]
  if (!expected) throw new LaunchLocaleError(`--expect must be one of ${Object.keys(EXPECTED).join(', ')}`)
  let page
  for (let attempt = 0; attempt < attempts && !page; attempt++) {
    if (attempt) await new Promise((resolvePromise) => setTimeout(resolvePromise, intervalMs))
    try {
      const response = await fetch(`http://127.0.0.1:${devtoolsPort}/json/list`)
      if (response.ok) page = viewerPage(await response.json(), viewerPort)
    } catch {
      // DevTools may still be starting.
    }
  }
  if (!page) {
    throw new LaunchLocaleError(`no page for http://127.0.0.1:${viewerPort}/ on DevTools port ${devtoolsPort}`)
  }
  let observed
  try {
    observed = JSON.parse(await evaluate(page.webSocketDebuggerUrl, PROBE, timeoutMs))
  } catch (err) {
    if (err instanceof LaunchLocaleError) throw err
    throw new LaunchLocaleError(`the probe returned no JSON: ${err.message}`)
  }
  const mismatches = localeMismatches(observed, expected)
  if (mismatches.length) throw new LaunchLocaleError(`the page does not run in ${expect}: ${mismatches.join('; ')}`)
  return observed
}

function port(value, name) {
  const number = Number(value)
  if (!Number.isInteger(number) || number < 1 || number > 65_535) {
    throw new LaunchLocaleError(`--${name} must be a TCP port`)
  }
  return number
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      'devtools-port': { type: 'string' },
      'viewer-port': { type: 'string' },
      expect: { type: 'string' },
    },
  })
  const observed = await probeLaunchLocale({
    devtoolsPort: port(values['devtools-port'], 'devtools-port'),
    viewerPort: port(values['viewer-port'], 'viewer-port'),
    expect: values.expect,
  })
  process.stdout.write(`launch-locale-probe: the page runs in ${values.expect}: ${JSON.stringify(observed)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((err) => {
    process.stderr.write(`launch-locale-probe: ${err.message}\n`)
    process.exitCode = 1
  })
}
