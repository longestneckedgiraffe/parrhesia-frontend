export function getCurrentEffectiveTheme(): 'light' | 'dark' {
  return document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light'
}

export function toggleTheme(): void {
  const theme = getCurrentEffectiveTheme() === 'light' ? 'dark' : 'light'
  document.documentElement.setAttribute('data-theme', theme)
  try {
    localStorage.setItem('parrhesia-theme', theme)
  } catch {
    return
  }
}

export function initTheme(): void {
  try {
    const theme = localStorage.getItem('parrhesia-theme')
    if (theme === 'light' || theme === 'dark') {
      document.documentElement.setAttribute('data-theme', theme)
    }
  } catch {
    return
  }
}
