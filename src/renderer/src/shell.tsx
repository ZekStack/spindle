import { createContext, useContext, useEffect, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { GitBranch, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { UpdateDialog } from './components/update-dialog'
import { AccountShortcut } from './components/account-identity'
import { ActivityDialog } from './components/activity-dialog'

export type Theme = 'dark' | 'light'
export type Language = 'hu' | 'en'
type Appearance = {
  theme: Theme
  setTheme: (value: Theme) => void
  language: Language
  setLanguage: (value: Language) => void
}
const AppearanceContext = createContext<Appearance | null>(null)

export function useAppearance(): Appearance {
  const context = useContext(AppearanceContext)
  if (!context) throw new Error('Appearance context is unavailable')
  return context
}

function initialTheme(): Theme {
  return localStorage.getItem('spindle.theme') === 'light' ? 'light' : 'dark'
}

export function Shell({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(initialTheme)
  const { t, i18n } = useTranslation()
  useEffect(() => {
    document.documentElement.classList.toggle('dark', theme === 'dark')
    localStorage.setItem('spindle.theme', theme)
  }, [theme])
  const setLanguage = (next: Language) => {
    void i18n.changeLanguage(next)
    localStorage.setItem('spindle.language', next)
  }
  const language: Language = i18n.language === 'hu' ? 'hu' : 'en'
  return <AppearanceContext.Provider value={{ theme, setTheme, language, setLanguage }}><div className="min-h-screen">
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur-xl">
      <div className="flex h-14 w-full items-center justify-between gap-3 px-5 lg:px-8">
        <Link to="/" className="flex items-center gap-3 text-[var(--fg)] no-underline">
          <div className="flex size-9 items-center justify-center rounded-lg bg-orange-500 text-neutral-950">
            <GitBranch className="size-5 stroke-[2.5]" />
          </div>
          <div className="min-w-0">
            <div className="text-[17px] font-bold tracking-tight">spindle</div>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <AccountShortcut/>
          <ActivityDialog/>
          <UpdateDialog/>
          <Link to="/settings" title={t('settingsTitle')} aria-label={t('settingsTitle')}
            className="flex size-9 items-center justify-center rounded-lg text-[var(--muted)] hover:bg-[var(--hover)] hover:text-[var(--fg)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-orange-500/60">
            <Settings2 className="size-4"/>
          </Link>
        </div>
      </div>
    </header>
    <main className="w-full px-5 pb-12 pt-6 lg:px-8">{children}</main>
  </div></AppearanceContext.Provider>
}
