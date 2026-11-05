import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, LogIn, X } from 'lucide-react'
import { useQuery } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import type { DeviceAuthProgress, DeviceAuthStart } from '../../../shared/contracts'
import { Button } from './ui/button'

/** A UI-only device-code presenter; token and device secret remain in main. */
export function DeviceSignIn({ onConnected }: { onConnected: () => void }) {
  const { t } = useTranslation()
  const setup = useQuery({
    queryKey: ['device-auth-setup'],
    queryFn: () => window.spindle.getDeviceAuthSetup(),
    staleTime: 60_000
  })
  const [clientId, setClientId] = useState('')
  const [flow, setFlow] = useState<DeviceAuthStart | null>(null)
  const [progress, setProgress] = useState<DeviceAuthProgress | null>(null)
  const [starting, setStarting] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    if (setup.data?.configuredClientId) setClientId(setup.data.configuredClientId)
  }, [setup.data?.configuredClientId])

  // Cancelling the dialog stops polling in the main process, not just React.
  useEffect(() => () => { void window.spindle.cancelDeviceAuth() }, [])

  useEffect(() => {
    if (!flow || (progress && progress.phase !== 'pending')) return
    let active = true
    const due = progress?.nextPollAt ?? flow.nextPollAt
    const timer = setTimeout(() => {
      void window.spindle.pollDeviceAuth().then((result) => {
        if (!active) return
        setProgress(result)
        if (result.phase === 'complete') {
          setFlow(null)
          onConnected()
        }
      }).catch(() => {
        if (active) setProgress({ phase: 'failed', nextPollAt: null })
      })
    }, Math.max(250, due - Date.now() + 150))
    return () => { active = false; clearTimeout(timer) }
  }, [flow, progress, onConnected])

  async function begin() {
    setStarting(true)
    setError(false)
    setProgress(null)
    try {
      const next = await window.spindle.startDeviceAuth(clientId.trim())
      setFlow(next)
    } catch {
      setError(true)
    } finally {
      setStarting(false)
    }
  }

  async function cancel() {
    setFlow(null)
    setProgress(null)
    await window.spindle.cancelDeviceAuth().catch(() => {})
  }

  const phase = progress?.phase
  const finished = phase && phase !== 'pending'
  return <section className="mt-5 border-t border-[var(--border)] pt-4">
    <h3 className="text-sm font-semibold">{t('deviceSignInTitle')}</h3>
    {!setup.data?.secureStorage ? <p className="mt-2 text-sm text-amber-400">
      {setup.isPending ? t('loading') : t('deviceSecureStorageUnavailable')}
    </p> : !flow ? <>
      <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">
        {t('deviceClientIdHelp')}
      </p>
      <label className="mt-3 block text-xs text-[var(--muted)]">
        {t('deviceClientIdLabel')}
        <input value={clientId} onChange={(event) => setClientId(event.target.value)}
          maxLength={128} autoComplete="off" spellCheck={false}
          placeholder="Ov23li..." className="mt-1 h-10 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 font-mono text-sm text-[var(--fg)] focus:border-orange-500 focus:outline-none" />
      </label>
      <Button className="mt-3" disabled={starting || !clientId.trim()}
        onClick={() => void begin()}>
        {starting ? <LoaderCircle className="size-4 animate-spin"/> : <LogIn className="size-4"/>}
        {t('deviceBegin')}
      </Button>
    </> : <div className="mt-3 space-y-3">
      <p className="text-xs text-[var(--muted)]">{t('deviceInstructions')}</p>
      <div className="rounded-xl border border-orange-500/30 bg-orange-500/5 p-4 text-center">
        <div className="text-xs text-[var(--muted)]">{t('deviceUserCode')}</div>
        <div className="mt-2 select-all font-mono text-2xl font-semibold tracking-[0.12em] text-orange-400">{flow.userCode}</div>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button onClick={() => {
          void window.spindle.openGitHub(flow.verificationUrl).catch(() => setError(true))
        }}>
          <ExternalLink className="size-4"/>{t('deviceOpenVerification')}
        </Button>
        <Button variant="secondary" onClick={() => void cancel()}>
          <X className="size-4"/>{t('cancel')}
        </Button>
      </div>
      <p role="status" className="text-xs text-[var(--muted)]">
        {phase === 'denied' ? t('deviceDenied')
          : phase === 'expired' ? t('deviceExpired')
            : phase === 'failed' ? t('deviceFailed')
              : phase === 'cancelled' ? t('deviceCancelled')
                : progress?.networkError ? t('deviceNetworkRetry')
                  : t('devicePending')}
      </p>
      {finished && <Button variant="secondary" onClick={() => void cancel()}>{t('deviceTryAgain')}</Button>}
    </div>}
    {error && <p role="alert" className="mt-3 text-sm text-red-400">{t('deviceStartFailed')}</p>}
  </section>
}
