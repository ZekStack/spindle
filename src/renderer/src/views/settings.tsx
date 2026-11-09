import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowLeft, Download, Globe2, Moon, Palette, ShieldCheck, Sun } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UpdateStatus } from '../../../shared/update-policy'
import { useAppearance, type Language, type Theme } from '../shell'
import { AccountIdentityPanel } from '../components/account-identity'
import { Button } from '../components/ui/button'

export function SettingsPage() {
  const { t } = useTranslation()
  const { theme, setTheme, language, setLanguage } = useAppearance()
  const queryClient = useQueryClient()
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus | null>(null)

  const preferences = useQuery({
    queryKey: ['spindle-update-preferences'],
    queryFn: () => window.spindle.getUpdatePreferences()
  })
  const save = useMutation({
    mutationFn: (includePrereleases: boolean) =>
      window.spindle.setUpdatePreferences({ includePrereleases }),
    onSuccess: (value) => queryClient.setQueryData(['spindle-update-preferences'], value)
  })
  useEffect(() => {
    let active = true
    const unsubscribe = window.spindle.onUpdateStatus((next) => {
      if (active) setUpdateStatus(next)
    })
    void window.spindle.getUpdateStatus().then((status) => {
      if (active) setUpdateStatus(status)
    }).catch(() => {})
    return () => { active = false; unsubscribe() }
  }, [])

  const updateBusy = updateStatus &&
    ['downloading', 'ready', 'installing'].includes(updateStatus.phase)
  const channelDisabled = preferences.isPending || preferences.isError ||
    save.isPending || Boolean(updateBusy)

  return <div className="mx-auto max-w-4xl space-y-5">
    <div className="space-y-3">
      <Link to="/" className="inline-flex items-center gap-2 text-xs text-[var(--muted)] no-underline hover:text-[var(--fg)]">
        <ArrowLeft className="size-4"/>{t('backToWorkspace')}
      </Link>
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t('settingsTitle')}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{t('settingsDescription')}</p>
      </div>
    </div>

    <section className="panel p-5 lg:p-6" aria-labelledby="settings-updates-title">
      <div className="flex items-center gap-3">
        <Download className="size-5 text-orange-500"/>
        <h2 id="settings-updates-title" className="text-lg font-semibold">{t('settingsUpdates')}</h2>
      </div>
      <p className="mt-1 text-sm text-[var(--muted)]">{t('settingsUpdatesHint')}</p>
      <div className="mt-5 flex items-center justify-between gap-4 border-t border-[var(--border)] pt-4">
        <div className="min-w-0">
          <label htmlFor="settings-rc" className="block cursor-pointer text-sm font-medium">{t('settingsPrereleases')}</label>
          <p className="mt-1 max-w-xl text-xs leading-relaxed text-[var(--muted)]">{t('settingsPrereleasesHint')}</p>
        </div>
        <input id="settings-rc" type="checkbox" role="switch"
          aria-label={t('settingsPrereleases')}
          checked={preferences.data?.includePrereleases ?? false}
          disabled={channelDisabled}
          onChange={(event) => save.mutate(event.target.checked)}
          className="size-5 shrink-0 cursor-pointer accent-orange-500 disabled:cursor-not-allowed disabled:opacity-50"/>
      </div>
      {preferences.isPending && <p className="mt-3 text-xs text-[var(--muted)]">{t('loading')}</p>}
      {preferences.isError && <p role="alert" className="mt-3 text-xs text-red-400">{t('settingsLoadError')}</p>}
      {save.isError && <p role="alert" className="mt-3 text-xs text-red-400">{t('settingsSaveError')}</p>}
      {updateBusy && <p className="mt-3 text-xs text-[var(--muted)]">{t('settingsUpdateBusy')}</p>}
      <div className="mt-4 flex items-start gap-2 rounded-lg bg-[var(--surface-2)] p-3 text-xs text-[var(--muted)]">
        <ShieldCheck className="mt-0.5 size-4 shrink-0 text-orange-500"/>
        <span>{t('settingsUpdateSafety')}</span>
      </div>
    </section>

    <section className="panel p-5 lg:p-6" aria-labelledby="settings-appearance-title">
      <div className="flex items-center gap-3">
        <Palette className="size-5 text-orange-500"/>
        <h2 id="settings-appearance-title" className="text-lg font-semibold">{t('settingsAppearance')}</h2>
      </div>
      <p className="mt-1 text-sm text-[var(--muted)]">{t('settingsAppearanceHint')}</p>
      <fieldset className="mt-5 border-t border-[var(--border)] pt-4">
        <legend className="sr-only">{t('theme')}</legend>
        <div className="mb-2 text-sm font-medium">{t('theme')}</div>
        <div className="flex flex-wrap gap-2">
          {(['light', 'dark'] as const satisfies readonly Theme[]).map((option) =>
            <Button key={option} type="button" variant={theme === option ? 'secondary' : 'ghost'}
              aria-pressed={theme === option} onClick={() => setTheme(option)}>
              {option === 'light' ? <Sun className="size-4"/> : <Moon className="size-4"/>}
              {t(option)}
            </Button>
          )}
        </div>
      </fieldset>
      <fieldset className="mt-5 border-t border-[var(--border)] pt-4">
        <legend className="sr-only">{t('language')}</legend>
        <div className="mb-2 flex items-center gap-2 text-sm font-medium"><Globe2 className="size-4"/>{t('language')}</div>
        <div className="flex flex-wrap gap-2">
          {([['hu', 'Magyar'], ['en', 'English']] as const satisfies readonly (readonly [Language, string])[]).map(([value, label]) =>
            <Button key={value} type="button" variant={language === value ? 'secondary' : 'ghost'}
              aria-pressed={language === value} onClick={() => setLanguage(value)}>
              {label}
            </Button>
          )}
        </div>
      </fieldset>
    </section>
    <AccountIdentityPanel/>
  </div>
}
