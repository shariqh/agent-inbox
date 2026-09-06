async function withFreshHttpCache(win, navigate) {
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  // Legacy HTTP entries can bypass the fixed server's no-store policy.
  // Browser storage holds settings and drafts; clear only the HTTP cache.
  await win.webContents.session.clearCache()
  if (win.isDestroyed() || win.webContents.isDestroyed()) return
  return navigate()
}

function loadViewer(win, url) {
  return withFreshHttpCache(win, () => win.loadURL(url))
}

function reloadViewer(win) {
  return withFreshHttpCache(win, () => win.webContents.reload())
}

module.exports = { loadViewer, reloadViewer }
