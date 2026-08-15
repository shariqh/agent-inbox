(() => {
  const key = 'agent-inbox-theme'
  const valid = new Set(['light', 'dark', 'system'])
  let preference = 'light'
  try {
    const saved = localStorage.getItem(key)
    if (valid.has(saved)) preference = saved
  } catch {
    // Storage-disabled contexts retain the product's light-first default.
  }
  const systemDark = window.matchMedia?.('(prefers-color-scheme: dark)').matches === true
  document.documentElement.dataset.theme =
    preference === 'dark' || (preference === 'system' && systemDark) ? 'dark' : 'light'
  document.documentElement.dataset.themePreference = preference
})()
