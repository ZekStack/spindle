import { useEffect, useRef, useState } from 'react'
import { ArrowDownToLine, CheckCircle2, Download, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { UpdateStatus } from '../../../shared/update-policy'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { Button } from './ui/button'

export function UpdateDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [status, setStatus] = useState<UpdateStatus | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const offered = useRef<string | null>(null)

  useEffect(() => {
    let active = true
    const unsubscribe = window.spindle.onUpdateStatus((next) => {
      if (active) setStatus(next)
    })
    void window.spindle.getUpdateStatus().then((next) => {
      if (active) setStatus(next)
    }).catch(() => {
      if (active) setActionError(t('updateStatusUnavailable'))
    })
    return () => { active = false; unsubscribe() }
  }, [t])

  useEffect(() => {
    if (status?.phase === 'error' && status.message === 'not-installed' &&
        offered.current !== 'install-not-applied') {
      offered.current = 'install-not-applied'
      setOpen(true)
    }
    if (status && ['available', 'ready'].includes(status.phase) &&
        status.availableVersion && offered.current !== status.availableVersion) {
      offered.current = status.availableVersion
      setOpen(true)
    }
  }, [status])

  async function act(operation: () => Promise<UpdateStatus>): Promise<void> {
    setActionError(null)
    try { setStatus(await operation()) }
    catch { setActionError(t('updateActionFailed')) }
  }

  const phase = status?.phase ?? 'idle'
  const busy = ['checking', 'downloading', 'installing'].includes(phase)
  const hasUpdate = phase === 'available' || phase === 'ready'
  const dot = hasUpdate && status?.availableVersion
  const label = phase === 'ready' ? t('updateReady') :
    phase === 'available' ? t('updateAvailable') : t('updateTitle')

  return <>
    <Button
      size="icon"
      variant="ghost"
      title={label}
      aria-label={label}
      className="relative"
      onClick={() => setOpen(true)}
    >
      {busy ? <LoaderCircle className="size-4 animate-spin"/> : <Download className="size-4"/>}
      {dot && <span className="absolute right-1 top-1 size-2 rounded-full bg-orange-500" />}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <div className="flex items-center gap-3">
          <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500">
            <ArrowDownToLine className="size-5"/>
          </div>
          <div>
            <DialogTitle className="text-lg font-semibold">{t('updateTitle')}</DialogTitle>
            <DialogDescription className="mt-1 text-xs text-[var(--muted)]">
              {t('currentVersion')}: {status?.currentVersion ?? '—'}
            </DialogDescription>
          </div>
        </div>
        <div className="mt-6 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
          {(phase === 'available' || phase === 'downloading' || phase === 'ready' || phase === 'installing')
            && status?.availableVersion && <p className="mb-2 text-base font-semibold">
              {t('newVersion')}: <span className="text-orange-400">{status.availableVersion}</span>
            </p>}
          {phase === 'checking' && <p className="text-sm text-[var(--muted)]">{t('checkingUpdates')}</p>}
          {phase === 'available' && <p className="text-sm text-[var(--muted)]">{t('updateOffer')}</p>}
          {phase === 'up-to-date' && <div className="flex items-center gap-2 text-sm">
            <CheckCircle2 className="size-4 text-emerald-500"/>{t('upToDate')}
          </div>}
          {phase === 'idle' && <p className="text-sm text-[var(--muted)]">{t('updateCheckManually')}</p>}
          {phase === 'disabled' && <p className="text-sm text-[var(--muted)]">{t('updateDisabled')}</p>}
          {phase === 'ready' && <p className="text-sm text-[var(--muted)]">{t('updateDownloaded')}</p>}
          {phase === 'installing' && <p className="text-sm text-[var(--muted)]">{t('installingUpdate')}</p>}
          {phase === 'downloading' && <div className="space-y-3">
            <p className="text-sm text-[var(--muted)]">{t('downloadingUpdate')}</p>
            <div role="progressbar" aria-label={t('downloadingUpdate')} aria-valuemin={0} aria-valuemax={100} aria-valuenow={status?.percent ?? 0}
              className="h-2 overflow-hidden rounded-full bg-[var(--border)]">
              <div className="h-full rounded-full bg-orange-500 transition-[width] duration-200"
                style={{ width: `${status?.percent ?? 0}%` }}/>
            </div>
            <p className="text-right text-xs text-[var(--muted)]">{status?.percent ?? 0}%</p>
          </div>}
          {(phase === 'error' || actionError) && <p role="alert" className="text-sm text-red-400">
            {actionError || (status?.message === 'auth' ? t('updateErrorAuth') :
              status?.message === 'network' ? t('updateErrorNetwork') :
              status?.message === 'verification' ? t('updateErrorVerification') :
              status?.message === 'install-failed' ? t('updateErrorInstallFailed') :
              status?.message === 'wrong-launcher' ? t('updateErrorWrongLauncher') :
              status?.message === 'not-installed' ? t('updateErrorNotInstalled') : t('updateActionFailed'))}
          </p>}
        </div>
        <p className="mt-3 text-xs leading-relaxed text-[var(--muted)]">{t('updateSecurityNote')}</p>
        <div className="mt-6 flex flex-wrap items-center justify-between gap-2">
          <Button variant="ghost" size="sm" onClick={() => {
            void window.spindle.openGitHub('https://github.com/ZekStack/spindle/releases')
              .catch(() => setActionError(t('updateActionFailed')))
          }}>
            <ExternalLink className="size-3.5"/>{t('viewReleases')}
          </Button>
          <div className="flex gap-2">
            {phase === 'available' && <Button disabled={busy} onClick={() => void act(() => window.spindle.downloadUpdate())}>
              <ArrowDownToLine className="size-4"/>{t('downloadUpdate')}
            </Button>}
            {phase === 'ready' && <Button onClick={() => void act(() => window.spindle.installUpdate())}>
              <RefreshCw className="size-4"/>{t('installRestart')}
            </Button>}
            {(phase === 'idle' || phase === 'error' || phase === 'up-to-date') &&
              <Button variant="secondary" disabled={busy} onClick={() => void act(() => window.spindle.checkForUpdates())}>
                <RefreshCw className="size-4"/>{t('checkUpdates')}
              </Button>}
          </div>
        </div>
      </DialogContent>
    </Dialog>
  </>
}
