export const THEME_STORAGE_KEY = 'agent-inbox-theme'
export const THEME_PREFERENCES = Object.freeze(['light', 'dark', 'system'])

const isThemePreference = (value) => THEME_PREFERENCES.includes(value)

export function readThemePreference(storage) {
  try {
    const value = storage?.getItem?.(THEME_STORAGE_KEY)
    return isThemePreference(value) ? value : 'light'
  } catch {
    return 'light'
  }
}

export function saveThemePreference(storage, preference) {
  if (!isThemePreference(preference)) {
    throw new TypeError(`Invalid theme preference: ${String(preference)}`)
  }
  storage.setItem(THEME_STORAGE_KEY, preference)
  return preference
}

export function resolveTheme(preference, systemDark) {
  if (preference === 'dark') return 'dark'
  if (preference === 'system' && systemDark) return 'dark'
  return 'light'
}

export function createThemeController({ storage, root, media, onChange = () => {} }) {
  let preference = readThemePreference(storage)

  const apply = () => {
    const effective = resolveTheme(preference, media.matches)
    root.dataset.theme = effective
    root.dataset.themePreference = preference
    onChange(preference, effective)
    return effective
  }
  const systemChanged = () => {
    if (preference === 'system') apply()
  }

  media.addEventListener('change', systemChanged)
  apply()

  return {
    get preference() { return preference },
    get effective() { return resolveTheme(preference, media.matches) },
    setPreference(next) {
      preference = saveThemePreference(storage, next)
      return apply()
    },
    destroy() {
      media.removeEventListener('change', systemChanged)
    },
  }
}
