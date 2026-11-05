import { AlertTriangle, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { localizedGitHubError } from '../lib/utils'

export function Busy() {
  const { t } = useTranslation()
  return <div className="flex items-center gap-2 py-10 text-sm text-[var(--muted)]"><LoaderCircle className="size-4 animate-spin text-orange-500" />{t('loading')}</div>
}
export function ErrorState({ error, retry }: { error: unknown; retry?: () => void }) {
  const { t } = useTranslation()
  return <div role="alert" className="rounded-xl border border-red-500/25 bg-red-500/5 p-5">
    <div className="flex items-center gap-2 text-sm font-semibold text-red-400"><AlertTriangle className="size-4"/>{t('loadError')}</div>
    <p className="mt-2 break-words text-sm text-[var(--muted)]">{localizedGitHubError(error, t)}</p>
    {retry && <Button variant="secondary" size="sm" className="mt-4" onClick={retry}><RefreshCw className="size-3.5"/>{t('retry')}</Button>}
  </div>
}
export function ExternalGitHub({ url }: { url: string }) {
  const { t } = useTranslation()
  return <Button variant="ghost" size="sm" title={t('openGitHub')} onClick={() => { void window.spindle.openGitHub(url) }}>
    <ExternalLink className="size-4"/><span className="sr-only">{t('openGitHub')}</span>
  </Button>
}
export function Chip({ children, tone = 'neutral' }: { children: React.ReactNode; tone?: 'neutral' | 'orange' | 'green' | 'red' }) {
  const colors = {
    neutral: 'bg-[var(--surface-2)] text-[var(--muted)] border-[var(--border)]',
    orange: 'bg-orange-500/12 text-orange-400 border-orange-500/20',
    green: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20',
    red: 'bg-red-500/10 text-red-400 border-red-500/20'
  }
  return <span className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[11px] font-medium ${colors[tone]}`}>{children}</span>
}
