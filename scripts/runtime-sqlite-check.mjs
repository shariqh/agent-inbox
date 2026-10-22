#!/usr/bin/env node
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const [storePath, ...extra] = process.argv.slice(2)
if (!storePath || extra.length) {
  throw new Error('usage: runtime-sqlite-check.mjs <runtime-dist/store.js>')
}

const { openDb, getItem } = await import(pathToFileURL(resolve(storePath)).href)
const db = openDb(':memory:')
try {
  // Node 24.19's ObjectWrap cleanup regression needs allocation-driven GC:
  // an explicit global.gc() or open/close selftest does not reproduce it (#135).
  let allocations = []
  for (let i = 0; i < 300_000; i++) {
    getItem(db, 'runtime-sqlite-gc-check')
    allocations.push({ i })
    if (allocations.length > 1_000) allocations = []
  }
} finally {
  db.close()
}
