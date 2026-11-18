// The words for sharing this Inbox with the owner's other Macs (#617, PR 2d): one table from a
// reason word the hub's controller gives (electron/remote-entry.d.cts) to the words a person
// reads. Settings → Other devices (public/remote-settings.js) shows them, and Electron main imports
// this file for its notifications, so the panel and a notification never say two things.
// test/remote-words.test.ts checks that every reason word in the .d.cts has words here.
//
// Plain words: "this Mac", "your other Macs", "paired Mac", "sharing". Tailscale and Tailscale
// Serve are product names the owner uses. One style: a status line's reason (`why`) is a clause
// with no full stop; everything else is whole sentences; "can't" and "couldn't", never "could not".

// What a family says: `why` for the status line ("Paused: <why>" / "Needs you: <why>"), `was` for
// a refused switch-on, in the past tense ("Switching on didn't work: <was>. …"), `refused`
// for what to do when switching on was refused or sharing stopped, `paused` for what to do while
// it comes back by itself. `command`: the instruction ends with a command and Copy (true: this
// build's `tailscale serve --bg <port>`; a string: that command). `repair`: it offers the one
// repair. `{port}` is this build's port; `{macs}`, `{was}` and `{them}` follow the count.
const THEN = 'Sharing then comes back by itself.'
const FAMILY_WORDS = Object.freeze({
  serve_setup: {
    why: 'Tailscale Serve is not set up for Agent Inbox',
    was: 'Tailscale Serve wasn’t set up for Agent Inbox',
    refused: 'Run this once in Terminal on this Mac, then switch on again:',
    paused: 'Run this once in Terminal on this Mac, and sharing comes back by itself:',
    command: true,
  },
  serve_replace: {
    why: 'Tailscale Serve on this Mac forwards this address to something else',
    was: 'Tailscale Serve on this Mac was forwarding this address to something else',
    refused: 'Tailscale Serve on this Mac is forwarding this address to something else. This replaces it:',
    command: true,
  },
  serve_unknown: {
    why: 'Tailscale Serve on this Mac is set up in a way Agent Inbox doesn’t recognise',
    was: 'Tailscale Serve on this Mac was set up in a way Agent Inbox doesn’t recognise',
    refused: 'Tailscale Serve on this Mac is set up in a way Agent Inbox doesn’t recognise. Run this in Terminal to see it:',
    command: 'tailscale serve status',
  },
  serve_other: {
    why: 'Tailscale Serve on this Mac forwards other things too',
    was: 'Tailscale Serve on this Mac was forwarding other things too',
    refused: 'Tailscale Serve on this Mac has other settings that could reach this Inbox. Remove them, then switch on again.',
    paused: `Tailscale Serve on this Mac has other settings that could reach this Inbox. Remove them. ${THEN}`,
  },
  funnel: {
    why: 'Tailscale Funnel is on for this Mac',
    was: 'Tailscale Funnel was on for this Mac',
    refused: 'Tailscale Funnel would put this Inbox on the internet. Turn Funnel off for this Mac, then switch on again.',
    paused: `Tailscale Funnel would put this Inbox on the internet. Turn Funnel off for this Mac. ${THEN}`,
  },
  serve_running: {
    why: 'another tailscale serve is running',
    was: 'another tailscale serve was running',
    refused: 'Another tailscale serve is running on this Mac. Stop it, then switch on again.',
    paused: `Another tailscale serve is running on this Mac. Stop it. ${THEN}`,
  },
  serve_service: {
    why: 'a Tailscale Service is set up on this Mac',
    was: 'a Tailscale Service was set up on this Mac',
    refused: 'A Tailscale Service is set up on this Mac, and Agent Inbox can’t check what it forwards. Remove it, then switch on again.',
    paused: `A Tailscale Service is set up on this Mac, and Agent Inbox can’t check what it forwards. Remove it. ${THEN}`,
  },
  no_tailscale: {
    why: 'Tailscale is not installed',
    was: 'Tailscale wasn’t installed',
    refused: 'Install Tailscale on this Mac and sign in, then switch on again.',
    paused: `Install Tailscale on this Mac and sign in. ${THEN}`,
  },
  tailscale_off: {
    why: 'Tailscale is not running',
    was: 'Tailscale wasn’t running',
    refused: 'Open Tailscale on this Mac and connect, then switch on again.',
    paused: `Open Tailscale on this Mac and connect. ${THEN}`,
  },
  tailscale_signin: {
    why: 'Tailscale is signed out',
    was: 'Tailscale was signed out',
    refused: 'Sign in to Tailscale on this Mac, then switch on again.',
    paused: `Sign in to Tailscale on this Mac. ${THEN}`,
  },
  tailscale_name: {
    why: 'Tailscale gives this Mac no usable name',
    was: 'Tailscale gave this Mac no usable name',
    refused: 'Check that MagicDNS is on for your Tailscale network, then switch on again.',
    paused: `Check that MagicDNS is on for your Tailscale network. ${THEN}`,
  },
  tailscale_unreadable: {
    why: 'Agent Inbox can’t read Tailscale',
    was: 'Agent Inbox couldn’t read Tailscale',
    refused: 'Check that Tailscale is running on this Mac, then switch on again.',
    paused: `Check that Tailscale is running on this Mac. ${THEN}`,
  },
  tagged: {
    why: 'this Mac uses a tagged Tailscale login',
    was: 'this Mac used a tagged Tailscale login',
    refused: 'Sharing needs a personal Tailscale login on this Mac. Sign in to Tailscale with your own account, then switch on again.',
  },
  identity: {
    why: 'this Mac’s Tailscale name or account changed',
    was: 'this Mac’s Tailscale name or account had changed',
    refused: 'This Mac’s Tailscale name or account changed. Switching on again removes the paired Macs.',
  },
  would_remove: {
    why: 'this Mac’s Tailscale name or account changed',
    was: 'this Mac’s Tailscale name or account had changed',
    refused: 'This Mac’s Tailscale name or account has changed since {these} paired. Switching on removes {macs}; pair {them} again afterwards.',
  },
  switch_again: {
    why: 'sharing needs you to switch it on again',
    was: 'sharing needed you to switch it on again',
    refused: 'Switch on again to share.',
  },
  changed: {
    why: 'the sharing settings were changed outside Agent Inbox',
    was: 'the sharing settings had been changed outside Agent Inbox',
    refused: 'Check the settings above, then switch on again.',
    paused: 'Agent Inbox is checking the changed settings.',
  },
  not_wanted: {
    why: 'sharing was switched on outside Agent Inbox while it was switched off here, so Agent Inbox switched it off again',
    was: 'sharing had been switched on outside Agent Inbox while it was switched off here',
    refused: 'Sharing was switched on outside Agent Inbox while it was switched off here, so Agent Inbox switched it off again.',
  },
  other_build: {
    why: 'the other copy of Agent Inbox on this Mac is sharing',
    was: 'the other copy of Agent Inbox on this Mac was sharing',
    refused: 'The other copy of Agent Inbox on this Mac (the installed app or a build from source) is sharing. Switch it off there first.',
  },
  file_open: {
    why: 'other accounts on this Mac can read the sharing settings',
    was: 'other accounts on this Mac could read the sharing settings',
    refused: 'Other accounts on this Mac can read the sharing settings file. Making it private switches sharing off and removes the paired Macs.',
    repair: true,
  },
  file_newer: {
    why: 'a newer Agent Inbox saved these settings',
    was: 'a newer Agent Inbox had saved these settings',
    refused: 'A newer version of Agent Inbox saved these settings. Update Agent Inbox to change them.',
  },
  file_fields: {
    why: 'the sharing settings file has a value Agent Inbox can’t use',
    was: 'the sharing settings file had a value Agent Inbox can’t use',
    refused: 'The sharing settings file has a value Agent Inbox can’t use. Switching on writes it again.',
  },
  file_damaged: {
    why: 'Agent Inbox can’t read its sharing settings file',
    was: 'Agent Inbox couldn’t read its sharing settings file',
    refused: 'Agent Inbox can’t read its sharing settings file, remote.json beside the Inbox database. Remove that file, then switch on again.',
  },
  write_failed: {
    why: 'Agent Inbox couldn’t save the sharing settings',
    was: 'Agent Inbox couldn’t save the sharing settings',
    refused: 'Agent Inbox couldn’t save its sharing settings file. Try again.',
    paused: 'Agent Inbox couldn’t save its sharing settings file. It tries again by itself.',
  },
  port_clash: {
    why: 'sharing would use the Inbox’s own port',
    was: 'sharing would have used the Inbox’s own port',
    refused: 'Sharing can’t use the same port as the Inbox itself. Choose another AGENT_INBOX_REMOTE_PORT.',
  },
  port_in_use: {
    why: 'another program on this Mac is using port {port}',
    was: 'another program on this Mac was using port {port}',
    refused: 'Quit that program, or switch sharing off. Until then Tailscale forwards your other Macs to it.',
  },
  cannot_listen: {
    why: 'Agent Inbox can’t listen on port {port}',
    was: 'Agent Inbox couldn’t listen on port {port}',
    refused: 'Switch sharing off and on again. If that doesn’t help, restart this Mac.',
  },
  self_unreachable: {
    why: 'Agent Inbox can’t reach its own Inbox',
    was: 'Agent Inbox couldn’t reach its own Inbox',
    refused: 'Quit and reopen Agent Inbox.',
  },
  failed: {
    why: 'something went wrong',
    was: 'something went wrong',
    refused: 'Something went wrong. Try again.',
  },
})

const SELF_FAMILY = {
  no_cli: 'no_tailscale', failed: 'tailscale_unreadable', not_json: 'tailscale_unreadable', not_running: 'tailscale_off',
  no_dns_name: 'tailscale_name', bad_host: 'tailscale_name', tagged: 'tagged', no_login: 'tailscale_signin',
}
// as electron/remote-tailscale.cjs reads each: what running `tailscale serve --bg` would and would not fix
const SERVE_FAMILY = {
  unreadable: 'tailscale_unreadable', bad_request: 'tailscale_unreadable', unknown_shape: 'serve_unknown', foreground: 'serve_running',
  services: 'serve_service', funnel: 'funnel', tcp_forward: 'serve_other', other_proxy: 'serve_other', duplicate_host: 'serve_other',
  no_handler: 'serve_setup', other_path: 'serve_other', handler_fields: 'serve_replace', wrong_target: 'serve_replace', not_https: 'serve_unknown',
}
const PROBLEM_FAMILY = {
  unsupported: 'file_damaged', unreadable: 'file_damaged', not_regular: 'file_damaged', not_owner: 'file_damaged',
  open_to_others: 'file_open', too_large: 'file_damaged', not_json: 'file_damaged', not_object: 'file_damaged', no_schema: 'file_damaged',
  newer_schema: 'file_newer', bad_host: 'file_fields', bad_logins: 'file_fields', bad_port: 'file_fields', bad_devices: 'file_damaged',
  other_viewer: 'other_build',
}
const WRITE_FAMILY = {
  ...PROBLEM_FAMILY, missing: 'file_damaged', bad_id: 'failed', bad_file: 'file_damaged', too_large_to_write: 'file_damaged',
  not_serialisable: 'file_damaged', port_clash: 'port_clash', write_failed: 'write_failed', not_needed: 'failed', failed: 'failed',
  would_remove_devices: 'would_remove',
}
const WAITING_FAMILY = {
  tailscale_not_running: 'tailscale_off', tailscale_unreadable: 'tailscale_unreadable', flagged: 'changed', changed_outside: 'changed',
  needs_owner: 'switch_again', write_failed: 'write_failed',
}
const STOP_FAMILY = { ...SELF_FAMILY, ...SERVE_FAMILY, identity_changed: 'identity', not_wanted: 'not_wanted' }
const LISTEN_FAMILY = { port_in_use: 'port_in_use', cannot_listen: 'cannot_listen' }

const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null)
const after = (word, prefix) => (typeof word === 'string' && word.startsWith(prefix) ? word.slice(prefix.length) : null)

/**
 * The family of a reason word: `kind` is `stop` (onStopped, state().stopped), `turnOn` (with its
 * `step`: `self`, `serve` or `file`), `waiting` (state().resume.waiting, which main refines to
 * `self_not_ok:<reason>` when that is what Tailscale said), `problem` (the file's) or `listen` (the
 * viewer's bind failure). A word this build does not know is `failed`, never nothing.
 */
export function reasonFamily(kind, reason, step) {
  let family = null
  if (kind === 'stop') family = own(STOP_FAMILY, reason)
  else if (kind === 'turnOn') family = own(step === 'self' ? SELF_FAMILY : step === 'serve' ? SERVE_FAMILY : WRITE_FAMILY, reason)
  else if (kind === 'waiting') {
    const serve = after(reason, 'serve_not_ok:')
    const self = after(reason, 'self_not_ok:')
    family = serve !== null ? own(SERVE_FAMILY, serve) : self !== null ? own(SELF_FAMILY, self) : own(WAITING_FAMILY, reason)
  } else if (kind === 'problem') family = own(PROBLEM_FAMILY, reason)
  else if (kind === 'listen') family = own(LISTEN_FAMILY, reason)
  return family ?? 'failed'
}

/**
 * A family's words with this build's port and the paired Macs filled in: `count` of them, and for
 * one, its `label` (text a Mac chose; the page sets every string as text).
 */
export function familyWords(family, { port = 0, count = 0, label = null } = {}) {
  const entry = own(FAMILY_WORDS, family) ?? FAMILY_WORDS.failed
  const one = count === 1
  const name = typeof label === 'string' && label !== '' ? label : 'the paired Mac'
  const fill = (text) => text
    .replaceAll('{port}', String(port))
    .replaceAll('{these}', one ? `${name} was` : 'these Macs were')
    .replaceAll('{macs}', one ? name : `the ${count} paired Macs`)
    .replaceAll('{them}', one ? 'it' : 'them')
  const out = { why: fill(entry.why), was: fill(entry.was), refused: fill(entry.refused) }
  if (entry.paused) out.paused = fill(entry.paused)
  if (entry.command) out.command = entry.command
  if (entry.repair) out.repair = true
  return out
}

/** What Test found, in words. */
export function testWords(result, host, port) {
  if (result && result.ok === true) return 'Working: Tailscale reaches this Inbox, and it asks for a paired Mac.'
  const reason = result?.reason
  const address = `https://${host}`
  if (reason === 'off') return 'Sharing is off, so there is nothing to test.'
  // the viewer had not opened the listener within 6 seconds
  if (reason === 'not_listening') return 'Sharing is still starting. Try again in a moment.'
  if (reason === 'port_in_use' || reason === 'cannot_listen') {
    const words = familyWords(reason, { port })
    return `${words.why[0].toUpperCase()}${words.why.slice(1)}. ${words.refused}`
  }
  // Serve answered 502, 503 or 504: it forwards, but nothing answers behind it
  if (reason === 'no_backend') return 'Tailscale is forwarding, but this Inbox isn’t answering.'
  if (reason === 'no_status') return 'Agent Inbox couldn’t read its own sharing status. Try again.'
  if (reason === 'unreachable') return `This Mac couldn’t reach ${address} through Tailscale. Check Tailscale Serve.`
  if (reason === 'not_refused') return `${address} answered without asking for a paired Mac. Check Tailscale Serve.`
  if (reason === 'no_device_count') {
    if (result.rose === 'host') return 'Tailscale reached this Inbox under another address. Check Tailscale Serve.'
    if (result.rose === 'login') return 'Tailscale reached this Inbox without your login. Check that this Mac is signed in to Tailscale as you.'
    if (result.rose === 'funnel') return 'Tailscale reached this Inbox through Funnel. Turn Funnel off for this Mac.'
    return 'Tailscale answered, but the request didn’t reach this Inbox’s check. Check Tailscale Serve.'
  }
  return 'The test couldn’t run. Try again.'
}

/** Why Add a Mac made no code. */
export function codeWords(reason) {
  if (reason === 'off') return 'Switch sharing on first.'
  if (reason === 'not_listening') return 'Sharing isn’t ready yet. Try again in a moment.'
  if (reason === 'unreachable') return 'Agent Inbox couldn’t reach its own Inbox. Try again.'
  return 'Agent Inbox couldn’t make a code. Try again.'
}
