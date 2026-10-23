#!/usr/bin/env node
// #87 PR 2b, CI only: add one open question to the standard user's inbox, through
// the installed app's own bundled runtime (`resources\app\runtime\win32-x64`), so
// the running app's attention watch announces it with a Windows notification.
// Usage: node.exe question.mjs <runtime dist\store.js> <title>
import { pathToFileURL } from 'node:url'

const [storePath, title] = process.argv.slice(2)
if (!storePath || !title) {
  process.stderr.write('usage: question.mjs <store.js> <title>\n')
  process.exit(2)
}
const { insertItem, openDb } = await import(pathToFileURL(storePath).href)
const db = openDb()
try {
  const id = insertItem(db, {
    project: 'windows-msi-lifecycle',
    stream: 'ci',
    agent: 'windows-msi',
    kind: 'question',
    title,
    detail: 'The MSI lifecycle checks that this question reaches a Windows notification.',
    next_step: 'No action: CI evidence only.',
    action_owner: 'task',
    impact: 'Shows which shortcut identity the app announces under.',
  })
  process.stdout.write(`${JSON.stringify({ id })}\n`)
} finally {
  db.close()
}
