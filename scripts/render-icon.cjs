// Render assets/icon.svg to a 1024px PNG using Electron's renderer (already a
// devDependency — no extra rasterizer needed). Used by scripts/make-icns.sh.
const { app, BrowserWindow } = require('electron')
const { readFileSync, writeFileSync } = require('node:fs')
const path = require('node:path')

const root = path.resolve(__dirname, '..')
const svg = readFileSync(path.join(root, 'assets', 'icon.svg'), 'utf8')
const out = process.argv[2] || path.join(root, 'assets', 'icon-1024.png')

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 1024, height: 1024, frame: false, transparent: true })
  const html = `<!doctype html><body style="margin:0;background:transparent">${svg}</body>`
  await win.loadURL('data:text/html;base64,' + Buffer.from(html).toString('base64'))
  await new Promise((r) => setTimeout(r, 300))
  const image = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 })
  writeFileSync(out, image.toPNG())
  console.log('wrote', out)
  app.exit(0)
}).catch((e) => { console.error(e); app.exit(1) })
