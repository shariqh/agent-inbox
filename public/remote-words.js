// The words for sharing this Inbox with the owner's other Macs (#617, PR 2d): one table from a
// reason word the hub's controller gives (electron/remote-entry.d.cts) to the sentence a person
// reads. Settings → Other devices (public/remote-settings.js) shows them, and Electron main imports
// this file for the text of its notifications, so the panel and a notification never say two
// things. test/remote-words.test.ts checks that every reason word in the .d.cts has words here.
//
// Plain words: "this Mac", "your other Macs", "paired Mac", "sharing". Tailscale and Tailscale
// Serve are product names the owner uses.

// What a family says: `why` for the status line ("Paused: <why>" / "Needs you: <why>"), `refused`
// for what to do when switching on was refused or sharing stopped, `paused` for what to do while
// it comes back by itself. `command`: the instruction ends with the Serve command and Copy;
// `repair`: it offers the one repair.
const BY_ITSELF = 'Sharing comes back by itself.'
export const FAMILY_WORDS = Object.freeze({
  serve_setup: {
    why: 'Tailscale Serve is not set up for Agent Inbox',
    refused: 'Run this once in Terminal on this Mac, then switch on again:',
    paused: 'Run this once in Terminal on this Mac, and sharing comes back by itself:',
    command: true,
  },
  serve_other: {
    why: 'Tailscale Serve on this Mac forwards other things too',
    refused: 'Tailscale Serve on this Mac has other settings that could reach this Inbox. Remove them, then switch on again.',
    paused: `Tailscale Serve on this Mac has other settings that could reach this Inbox. Remove them. ${BY_ITSELF}`,
  },
  funnel: {
    why: 'Tailscale Funnel is on for this Mac',
    refused: 'Tailscale Funnel would put this Inbox on the internet. Turn Funnel off for this Mac, then switch on again.',
    paused: `Tailscale Funnel would put this Inbox on the internet. Turn Funnel off for this Mac. ${BY_ITSELF}`,
  },
  serve_running: {
    why: 'another tailscale serve is running',
    refused: 'Another tailscale serve is running on this Mac. Stop it, then switch on again.',
    paused: `Another tailscale serve is running on this Mac. Stop it. ${BY_ITSELF}`,
  },
  no_tailscale: {
    why: 'Tailscale is not installed',
    refused: 'Install Tailscale on this Mac and sign in, then switch on again.',
    paused: `Install Tailscale on this Mac and sign in. ${BY_ITSELF}`,
  },
  tailscale_off: {
    why: 'Tailscale is not running',
    refused: 'Open Tailscale on this Mac and connect, then switch on again.',
    paused: `Open Tailscale on this Mac and connect. ${BY_ITSELF}`,
  },
  tailscale_signin: {
    why: 'Tailscale is signed out',
    refused: 'Sign in to Tailscale on this Mac, then switch on again.',
    paused: `Sign in to Tailscale on this Mac. ${BY_ITSELF}`,
  },
  tailscale_name: {
    why: 'Tailscale gives this Mac no usable name',
    refused: 'Check that MagicDNS is on for your Tailscale network, then switch on again.',
    paused: `Check that MagicDNS is on for your Tailscale network. ${BY_ITSELF}`,
  },
  tailscale_unreadable: {
    why: 'Agent Inbox can’t read Tailscale',
    refused: 'Check that Tailscale is running on this Mac, then switch on again.',
    paused: `Check that Tailscale is running on this Mac. ${BY_ITSELF}`,
  },
  tagged: {
    why: 'this Mac uses a tagged Tailscale login',
    refused: 'Sharing needs a personal Tailscale login on this Mac. Sign in to Tailscale with your own account, then switch on again.',
  },
  identity: {
    why: 'this Mac’s Tailscale name or account changed',
    refused: 'This Mac’s Tailscale name or account changed. Switching on again removes the paired Macs.',
  },
  switch_again: {
    why: 'sharing needs you to switch it on again',
    refused: 'Switch on again to share.',
  },
  changed: {
    why: 'the sharing settings were changed outside Agent Inbox',
    refused: 'Check the settings above, then switch on again.',
    paused: 'Agent Inbox is checking the changed settings.',
  },
  not_wanted: {
    why: 'sharing was switched on outside Agent Inbox',
    refused: 'Sharing was switched on outside Agent Inbox while it was off here, so Agent Inbox switched it off again. Switch on if you want it on.',
  },
  other_build: {
    why: 'the other copy of Agent Inbox on this Mac is sharing',
    refused: 'The other copy of Agent Inbox on this Mac (the installed app or a build from source) is sharing. Switch it off there first.',
  },
  file_open: {
    why: 'other accounts on this Mac can read the sharing settings',
    refused: 'Other accounts on this Mac can read the sharing settings file. Making it private switches sharing off and removes the paired Macs.',
    repair: true,
  },
  file_newer: {
    why: 'a newer Agent Inbox saved these settings',
    refused: 'A newer version of Agent Inbox saved these settings. Update Agent Inbox to change them.',
  },
  file_fields: {
    why: 'the sharing settings file has a value Agent Inbox can’t use',
    refused: 'The sharing settings file has a value Agent Inbox can’t use. Switching on writes it again.',
  },
  file_damaged: {
    why: 'Agent Inbox can’t read its sharing settings file',
    refused: 'Agent Inbox can’t read its sharing settings file, remote.json beside the Inbox database. Remove that file, then switch on again.',
  },
  write_failed: {
    why: 'Agent Inbox couldn’t save the sharing settings',
    refused: 'Agent Inbox couldn’t save its sharing settings file. Try again.',
    paused: 'Agent Inbox couldn’t save its sharing settings file. It tries again by itself.',
  },
  port_clash: {
    why: 'sharing would use the Inbox’s own port',
    refused: 'Sharing can’t use the same port as the Inbox itself. Choose another AGENT_INBOX_REMOTE_PORT.',
  },
  failed: {
    why: 'something went wrong',
    refused: 'Something went wrong. Try again.',
  },
})

const SELF_FAMILY = {
  no_cli: 'no_tailscale', failed: 'tailscale_unreadable', not_json: 'tailscale_unreadable', not_running: 'tailscale_off',
  no_dns_name: 'tailscale_name', bad_host: 'tailscale_name', tagged: 'tagged', no_login: 'tailscale_signin',
}
const SERVE_FAMILY = {
  unreadable: 'tailscale_unreadable', bad_request: 'tailscale_unreadable', unknown_shape: 'serve_other', foreground: 'serve_running',
  services: 'serve_running', funnel: 'funnel', tcp_forward: 'serve_other', other_proxy: 'serve_other', duplicate_host: 'serve_other',
  no_handler: 'serve_setup', other_path: 'serve_other', handler_fields: 'serve_setup', wrong_target: 'serve_setup', not_https: 'serve_setup',
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
}
const WAITING_FAMILY = {
  tailscale_not_running: 'tailscale_off', tailscale_unreadable: 'tailscale_unreadable', flagged: 'changed', changed_outside: 'changed',
  needs_owner: 'switch_again', write_failed: 'write_failed',
}
const STOP_FAMILY = { ...SELF_FAMILY, ...SERVE_FAMILY, identity_changed: 'identity', not_wanted: 'not_wanted' }

const own = (table, key) => (typeof key === 'string' && Object.hasOwn(table, key) ? table[key] : null)

/**
 * The family of a reason word: `kind` is `stop` (onStopped, state().stopped), `turnOn` (with its
 * `step`: `self`, `serve` or `file`), `waiting` (state().resume.waiting) or `problem` (the file's).
 * A word this build does not know is `failed`, never nothing.
 */
export function reasonFamily(kind, reason, step) {
  let family = null
  if (kind === 'stop') family = own(STOP_FAMILY, reason)
  else if (kind === 'turnOn') family = own(step === 'self' ? SELF_FAMILY : step === 'serve' ? SERVE_FAMILY : WRITE_FAMILY, reason)
  else if (kind === 'waiting') {
    family = typeof reason === 'string' && reason.startsWith('serve_not_ok:') ? own(SERVE_FAMILY, reason.slice('serve_not_ok:'.length)) : own(WAITING_FAMILY, reason)
  } else if (kind === 'problem') family = own(PROBLEM_FAMILY, reason)
  return family ?? 'failed'
}

// A notification after sharing stopped and will not come back by itself: one sentence per family.
const NOTICES = {
  serve: 'Tailscale Serve is not set up as expected.',
  identity: 'This Mac’s Tailscale name or account changed.',
  tailscale: 'Tailscale is not running, or Agent Inbox can’t read it.',
  not_wanted: 'Sharing is switched off, and the settings file said on.',
}
const NOTICE_OF = {
  serve_setup: 'serve', serve_other: 'serve', funnel: 'serve', serve_running: 'serve',
  identity: 'identity', tagged: 'identity', not_wanted: 'not_wanted',
}

/** The one sentence a stop that will not come back by itself is announced with, on screen too. */
export function stopNotice(reason) {
  return NOTICES[NOTICE_OF[reasonFamily('stop', reason)] ?? 'tailscale']
}

/** What Test found, in words. */
export function testWords(result, host) {
  if (result && result.ok === true) return 'Working: Tailscale reaches this Inbox, and it asks for a paired Mac.'
  const reason = result?.reason
  const address = `https://${host}`
  if (reason === 'off') return 'Sharing is off, so there is nothing to test.'
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
