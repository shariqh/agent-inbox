#!/usr/bin/env node
// #87 installer spike (CI only): build a Squirrel.Windows installer from one
// verified Windows folder with the electron-winstaller release this directory's
// lockfile pins, and report what the installer contains.
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'

const here = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)
const tools = JSON.parse(readFileSync(join(here, 'tools.json'), 'utf8'))
const winstallerRoot = join(here, 'node_modules', 'electron-winstaller')
const VENDOR = ['Squirrel.exe', 'Setup.exe', 'StubExecutable.exe', 'WriteZipToSetup.exe', 'nuget.exe', '7z.exe', 'rcedit.exe', 'signtool.exe']

function sha256(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function fileRecord(path) {
  return { name: basename(path), bytes: statSync(path).size, sha256: sha256(path) }
}

function assertPinnedTooling() {
  const installed = JSON.parse(readFileSync(join(winstallerRoot, 'package.json'), 'utf8'))
  const lock = JSON.parse(readFileSync(join(here, 'package-lock.json'), 'utf8'))
  const locked = lock.packages?.['node_modules/electron-winstaller']
  if (installed.version !== tools.squirrel.version || locked?.version !== tools.squirrel.version ||
      locked?.integrity !== tools.squirrel.integrity) {
    throw new Error(`electron-winstaller must be the pinned ${tools.squirrel.version} (${tools.squirrel.integrity})`)
  }
  for (const name of VENDOR) {
    if (!existsSync(join(winstallerRoot, 'vendor', name))) throw new Error(`electron-winstaller vendor/${name} is missing`)
  }
}

// The top-level entries of the folder that electron-winstaller's default nuspec
// template would not pack (its patterns name directories with \** and files with
// simple globs or exact names).
function defaultTemplateDrops(app, exe) {
  const template = readFileSync(join(winstallerRoot, 'template.nuspectemplate'), 'utf8')
  const patterns = [...template.matchAll(/<file src="([^"<]+)"/g)].map((match) => match[1])
  patterns.push(exe)
  if (existsSync(join(app, 'swiftshader'))) patterns.push('swiftshader\\**')
  if (existsSync(join(app, 'vk_swiftshader_icd.json'))) patterns.push('vk_swiftshader_icd.json')
  const covers = (name, directory) => patterns.some((pattern) => {
    if (pattern.endsWith('\\**')) return directory && pattern.slice(0, -3).toLowerCase() === name.toLowerCase()
    if (directory) return false
    const regex = new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('[^\\\\]*')}$`, 'i')
    return regex.test(name)
  })
  return readdirSync(app)
    .filter((name) => !covers(name, statSync(join(app, name)).isDirectory()))
    .sort()
}

function folderFiles(root, directory = root, out = []) {
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) folderFiles(root, path, out)
    else out.push(path.slice(root.length + 1).split('\\').join('/'))
  }
  return out
}

function packageEntries(nupkg) {
  const tar = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
  return execFileSync(tar, ['-tf', nupkg], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    .split(/\r?\n/)
    .filter(Boolean)
    .map((entry) => decodeURIComponent(entry))
}

const { values } = parseArgs({
  options: {
    app: { type: 'string' },
    output: { type: 'string' },
    work: { type: 'string' },
    icon: { type: 'string' },
    'icon-url': { type: 'string' },
    report: { type: 'string' },
  },
})
for (const name of ['app', 'output', 'work', 'icon', 'icon-url', 'report']) {
  if (!values[name]) throw new Error(`--${name} is required`)
}
assertPinnedTooling()
const { createWindowsInstaller } = require('electron-winstaller')

const app = resolve(values.app)
const output = resolve(values.output)
const work = resolve(values.work)
const exe = `${tools.identity.productName}.exe`
const pkg = JSON.parse(readFileSync(join(app, 'resources', 'app', 'package.json'), 'utf8'))
const version = pkg.version
const setupExe = `AgentInbox-${version}-x64-setup.exe`

// electron-winstaller writes Squirrel.exe into the app directory, so it gets a copy.
rmSync(work, { recursive: true, force: true })
mkdirSync(work, { recursive: true })
const appCopy = join(work, tools.identity.productName)
cpSync(app, appCopy, { recursive: true })
mkdirSync(output, { recursive: true })

const started = process.hrtime.bigint()
await createWindowsInstaller({
  appDirectory: appCopy,
  outputDirectory: output,
  name: tools.identity.squirrelPackageId,
  title: tools.identity.productName,
  exe,
  setupExe,
  version,
  authors: tools.identity.manufacturer,
  owners: tools.identity.manufacturer,
  description: pkg.description,
  setupIcon: resolve(values.icon),
  iconUrl: values['icon-url'],
  noMsi: true,
  noDelta: true,
  nuspecTemplate: join(here, 'squirrel.nuspectemplate'),
})
const seconds = Number(process.hrtime.bigint() - started) / 1e9

const nupkg = join(output, `${tools.identity.squirrelPackageId}-${version}-full.nupkg`)
for (const path of [join(output, setupExe), nupkg, join(output, 'RELEASES')]) {
  if (!existsSync(path)) throw new Error(`electron-winstaller did not produce ${path}`)
}
const prefix = 'lib/net45/'
const packaged = packageEntries(nupkg)
  .filter((entry) => entry.startsWith(prefix) && !entry.endsWith('/'))
  .map((entry) => entry.slice(prefix.length))
const packagedSet = new Set(packaged.map((entry) => entry.toLowerCase()))
const verified = new Set(folderFiles(app).map((entry) => entry.toLowerCase()))

const report = {
  schema: 1,
  kind: 'squirrel',
  version,
  seconds: Math.round(seconds * 10) / 10,
  electronWinstaller: tools.squirrel.version,
  setup: fileRecord(join(output, setupExe)),
  nupkg: fileRecord(nupkg),
  releases: readFileSync(join(output, 'RELEASES'), 'utf8').trim(),
  vendor: Object.fromEntries(VENDOR.map((name) => [name, sha256(join(winstallerRoot, 'vendor', name))])),
  packagedFiles: packaged.length,
  folderFiles: verified.size,
  missingFromPackage: [...verified].filter((entry) => !packagedSet.has(entry)).sort(),
  addedByPackage: packaged.filter((entry) => !verified.has(entry.toLowerCase())).sort(),
  packagedPeFiles: packaged.filter((entry) => /\.(exe|dll|node)$/i.test(entry)).sort(),
  defaultTemplateDrops: defaultTemplateDrops(app, exe),
}
writeFileSync(resolve(values.report), `${JSON.stringify(report, null, 2)}\n`)
process.stdout.write(`${JSON.stringify({ ok: true, version, setup: report.setup.name, seconds: report.seconds })}\n`)
