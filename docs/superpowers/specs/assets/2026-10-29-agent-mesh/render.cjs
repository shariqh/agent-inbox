// Renders each mockup HTML in this folder to a PNG with Electron, offline.
// Usage (from the repository root, Node 24):
//   npx electron docs/superpowers/specs/assets/2026-10-29-agent-mesh/render.cjs \
//     --user-data-dir=<scratch folder inside the checkout> [name.html ...]
// Loads file:// URLs only: no viewer server, no hub database, no network.
const { app, BrowserWindow, session } = require('electron')
const path = require('node:path')
const fs = require('node:fs')

const DIR = __dirname
const args = process.argv.slice(2).filter((a) => a.endsWith('.html'))
const pages = args.length ? args : fs.readdirSync(DIR).filter((f) => f.endsWith('.html')).sort()
const userData = process.argv.find((a) => a.startsWith('--user-data-dir='))?.slice('--user-data-dir='.length)
if (!userData) throw new Error('pass --user-data-dir=<scratch folder>')
app.setPath('userData', path.resolve(userData))
app.setPath('sessionData', path.resolve(userData))

app.disableHardwareAcceleration()
setTimeout(() => { process.stderr.write('render timed out\n'); app.exit(124) }, 120_000).unref()
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, done) => {
    const cancel = !/^(file|devtools|data):/.test(details.url)
    if (cancel) process.stderr.write(`blocked ${details.url}\n`)
    done({ cancel })
  })
  const win = new BrowserWindow({
    width: 1440, height: 900, show: false, useContentSize: true,
    webPreferences: { offscreen: true, javascript: false },
  })
  for (const page of pages) {
    process.stderr.write(`loading ${page}\n`)
    try {
      await win.loadFile(path.join(DIR, page))
    } catch (err) {
      process.stderr.write(`${page}: ${err.message}\n`)
      process.exitCode = 1
      continue
    }
    await new Promise((r) => setTimeout(r, 400))
    win.webContents.invalidate()
    const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1440, height: 900 })
    const out = path.join(DIR, page.replace(/\.html$/, '.png'))
    fs.writeFileSync(out, image.resize({ width: 1440 }).toPNG())
    process.stdout.write(`${path.basename(out)} ${fs.statSync(out).size}\n`)
  }
  win.destroy()
  app.quit()
})
