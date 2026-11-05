import { useEffect, useState } from 'react'
import { Activity, AlertTriangle, CircleCheck, CircleX, FolderOpen, LoaderCircle, RefreshCw, XCircle } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { activeJob, type JobErrorCode, type JobRecord } from '../../../shared/jobs'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

type Filter = 'active' | 'history'
function errorKey(code: JobErrorCode | null): string {
  switch (code) {
    case 'auth': return 'activityErrorAuth'
    case 'forbidden': return 'activityErrorForbidden'
    case 'not-found': return 'activityErrorNotFound'
    case 'rate-limit': return 'activityErrorRateLimit'
    case 'network': return 'activityErrorNetwork'
    case 'timeout': return 'activityErrorTimeout'
    case 'interrupted': return 'activityErrorInterrupted'
    case 'git-unavailable': return 'activityGitUnavailable'
    case 'git-failed': return 'activityLocalGitFailed'
    case 'output-limit': return 'activityErrorOutputLimit'
    default: return 'activityErrorUnknown'
  }
}

export function ActivityDialog() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [filter, setFilter] = useState<Filter>('active')
  const [selected, setSelected] = useState<string | null>(null)
  const [failure, setFailure] = useState(false)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let current = true
    const unsubscribe = window.spindle.onJobsChanged((updated) => {
      if (current) setJobs(updated)
    })
    void window.spindle.listJobs().then((initial) => {
      if (current) setJobs(initial)
    }).catch(() => { if (current) setFailure(true) })
    const show = () => {
      setOpen(true)
      setFilter('active')
    }
    window.addEventListener('spindle:activity:open', show)
    return () => {
      current = false
      unsubscribe()
      window.removeEventListener('spindle:activity:open', show)
    }
  }, [])

  const runningCount = jobs.filter((job) => activeJob(job.phase)).length
  const filtered = jobs.filter((job) => filter === 'active' ? activeJob(job.phase) : !activeJob(job.phase))
  const detail = filtered.find((job) => job.id === selected) ?? filtered[0] ?? null
  const labelFor = (job: JobRecord) => t(job.kind === 'local-git-inspection'
    ? 'activityLocalInspection' : job.kind === 'local-git-clone' ? 'activityClone'
      : job.kind === 'local-git-fetch' ? 'activityFetch'
        : job.kind === 'local-git-pull' ? 'activityPull' : 'activityInspection')

  async function inspectLocal() {
    setBusy(true)
    setFailure(false)
    try {
      const next = await window.spindle.pickLocalGitFolder()
      if (next) {
        setSelected(next.id)
        setFilter('active')
      }
    } catch { setFailure(true) }
    finally { setBusy(false) }
  }

  async function cancel(id: string) {
    setBusy(true)
    setFailure(false)
    try { await window.spindle.cancelJob(id) }
    catch { setFailure(true) }
    finally { setBusy(false) }
  }
  async function rerun(job: JobRecord) {
    setBusy(true)
    setFailure(false)
    try {
      const next = job.kind === 'local-git-inspection'
        ? await window.spindle.retryLocalGitJob(job.id)
        : await (async () => {
          const [owner, name] = job.repository.split('/')
          return window.spindle.inspectRepository(owner, name)
        })()
      setSelected(next.id)
      setFilter('active')
    } catch { setFailure(true) }
    finally { setBusy(false) }
  }

  return <>
    <Button variant="ghost" size="icon" className="relative" title={t('activityTitle')}
      aria-label={t('activityTitle')} onClick={() => setOpen(true)}>
      {runningCount ? <LoaderCircle className="size-4 animate-spin"/> : <Activity className="size-4"/>}
      {runningCount > 0 && <span className="absolute -right-0.5 -top-0.5 flex size-4 items-center justify-center rounded-full bg-orange-500 text-[10px] font-semibold text-black">
        {runningCount}
      </span>}
    </Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="flex max-h-[88vh] w-[min(96vw,920px)] flex-col overflow-hidden">
        <DialogTitle className="text-lg font-semibold">{t('activityTitle')}</DialogTitle>
        <DialogDescription className="mt-1 text-xs text-[var(--muted)]">
          {t('activityDescription')}
        </DialogDescription>
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <Button variant="secondary" size="sm" disabled={busy}
            onClick={() => void inspectLocal()}>
            <FolderOpen className="size-3.5"/>{t('activityInspectLocal')}
          </Button>
          <Button variant={filter === 'active' ? 'default' : 'secondary'} size="sm"
            onClick={() => { setFilter('active'); setSelected(null) }}>
            {t('activityRunning')} ({runningCount})
          </Button>
          <Button variant={filter === 'history' ? 'default' : 'secondary'} size="sm"
            onClick={() => { setFilter('history'); setSelected(null) }}>
            {t('activityHistory')} ({jobs.length - runningCount})
          </Button>
        </div>
        {failure && <p role="alert" className="mt-2 text-xs text-red-400">{t('activityFailed')}</p>}
        <div className="mt-3 grid min-h-0 flex-1 gap-3 overflow-y-auto md:grid-cols-[minmax(210px,0.9fr)_minmax(0,1.4fr)]">
          <div className="min-h-32 overflow-y-auto rounded-xl border border-[var(--border)]">
            {filtered.length === 0 && <p className="p-4 text-sm text-[var(--muted)]">
              {filter === 'active' ? t('activityNoActive') : t('activityNoHistory')}
            </p>}
            {filtered.map((job) => <button type="button" key={job.id}
              onClick={() => setSelected(job.id)}
              className={`w-full cursor-pointer border-b border-[var(--border)] px-4 py-3 text-left last:border-0 hover:bg-[var(--hover)] ${detail?.id === job.id ? 'bg-[var(--surface-2)]' : ''}`}>
              <div className="flex items-center gap-2 text-sm font-medium">
                {activeJob(job.phase) ? <LoaderCircle className="size-3.5 animate-spin text-orange-500"/>
                  : job.phase === 'completed' ? <CircleCheck className="size-3.5 text-emerald-500"/>
                    : job.phase === 'partial' ? <AlertTriangle className="size-3.5 text-amber-500"/>
                      : <CircleX className="size-3.5 text-red-400"/>}
                <span className="min-w-0 flex-1 truncate">{job.repository}</span>
              </div>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {labelFor(job)} · {t(`activityPhase_${job.phase}`)}
              </p>
            </button>)}
          </div>
          <section className="min-w-0 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
            {!detail ? <p className="text-sm text-[var(--muted)]">{t('activitySelect')}</p> : <>
              <h3 className="break-all text-sm font-semibold">{detail.repository}</h3>
              <p className="mt-1 text-xs text-[var(--muted)]">
                {labelFor(detail)} · {t(`activityPhase_${detail.phase}`)}
              </p>
              {detail.location && <p className="mt-1 break-all text-xs text-[var(--muted)]">
                {detail.location}
              </p>}
              <div className="mt-4 h-1.5 overflow-hidden rounded-full bg-[var(--border)]"
                role="progressbar" aria-label={t('activityProgress')} aria-valuemin={0}
                aria-valuemax={100} aria-valuenow={detail.progress}>
                <div className="h-full bg-orange-500" style={{ width: `${detail.progress}%` }}/>
              </div>
              <p className="mt-2 text-xs text-[var(--muted)]">
                {t('activityStarted')}: {detail.startedAt
                  ? new Date(detail.startedAt).toLocaleString()
                  : t('activityNotStarted')}
              </p>
              {detail.errorCode && <p role="alert" className="mt-3 text-sm text-red-400">
                {t(detail.kind === 'local-git-inspection' && detail.errorCode === 'not-found'
                  ? 'activityGitUnavailable' : errorKey(detail.errorCode))}
              </p>}
              {detail.errorCode && detail.retryable !== undefined &&
                <p className="mt-2 text-xs text-[var(--muted)]">
                  {t(detail.retryable ? 'activityRetryable'
                    : detail.kind === 'local-git-inspection'
                      ? 'activityLocalActionRequired' : 'activityActionRequired')}
                </p>}
              {detail.phase === 'partial' && <p role="status" className="mt-2 text-xs text-amber-400">
                {t('activityPartialNotice')}
              </p>}
              <div className="mt-4 max-h-48 space-y-1 overflow-y-auto rounded-lg border border-[var(--border)] bg-[var(--surface)] p-3"
                aria-label={t('activityOutput')}>
                {detail.output.map((line, index) =>
                  <p key={index} className="break-words font-mono text-xs text-[var(--muted)]">{line}</p>)}
              </div>
              <div className="mt-4 flex flex-wrap justify-end gap-2">
                {activeJob(detail.phase) ? <Button variant="secondary" size="sm" disabled={busy}
                  onClick={() => void cancel(detail.id)}>
                  <XCircle className="size-3.5"/>{t('activityCancel')}
                </Button> : (detail.kind === 'repository-inspection' || detail.kind === 'local-git-inspection')
                  ? <Button size="sm" variant="secondary" disabled={busy}
                  onClick={() => void rerun(detail)}>
                  <RefreshCw className="size-3.5"/>{t('activityRunAgain')}
                </Button> : null}
              </div>
            </>}
          </section>
        </div>
      </DialogContent>
    </Dialog>
  </>
}
