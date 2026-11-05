import { useEffect, useState, type ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { Activity, GitBranch, Globe2, Moon, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './components/ui/button'
import { AddOrganization } from './components/add-organization'
import { UpdateDialog } from './components/update-dialog'
import { AccountIdentity } from './components/account-identity'

type Theme = 'dark' | 'light'
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
  const switchLanguage = () => {
    const next = i18n.language === 'hu' ? 'en' : 'hu'
    void i18n.changeLanguage(next)
    localStorage.setItem('spindle.language', next)
  }
  return <div className="min-h-screen">
    <header className="sticky top-0 z-30 border-b border-[var(--border)] bg-[var(--surface)]/95 backdrop-blur-xl">
      <div className="mx-auto flex h-16 max-w-[1480px] items-center justify-between gap-3 px-5 lg:px-10">
        <Link to="/" className="flex items-center gap-3 text-[var(--fg)] no-underline">
          <div className="flex size-10 items-center justify-center rounded-xl bg-orange-500 text-neutral-950">
            <GitBranch className="size-5 stroke-[2.5]" />
          </div>
          <div className="min-w-0">
            <div className="text-[17px] font-bold tracking-tight">spindle</div>
            <div className="hidden text-[10px] font-medium uppercase tracking-[.2em] text-orange-500 sm:block">by ZekStack</div>
          </div>
        </Link>
        <div className="flex items-center gap-2">
          <AccountIdentity/>
          <AddOrganization compact />
          <UpdateDialog/>
          <Button variant="ghost" size="icon" title={t('language')} aria-label={t('language')} onClick={switchLanguage}>
            <Globe2 className="size-4"/><span className="absolute mt-7 ml-6 text-[9px] font-bold">{i18n.language.toUpperCase()}</span>
          </Button>
          <Button variant="ghost" size="icon" title={t('theme')} aria-label={t('theme')} onClick={() => setTheme((current) => current === 'dark' ? 'light' : 'dark')}>
            {theme === 'dark' ? <Sun className="size-4"/> : <Moon className="size-4"/>}
          </Button>
        </div>
      </div>
    </header>
    <main className="mx-auto max-w-[1480px] px-5 pb-16 pt-8 lg:px-10">{children}</main>
    <footer className="mx-auto flex max-w-[1480px] items-center justify-between border-t border-[var(--border)] px-5 py-5 text-xs text-[var(--muted)] lg:px-10">
      <span>Spindle</span>
      <span className="inline-flex items-center gap-1.5"><Activity className="size-3.5" />{t('readOnly')}</span>
    </footer>
  </div>
}
