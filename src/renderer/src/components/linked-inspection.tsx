import { useEffect, useState } from 'react'
import { RotateCcw } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { activeJob, type JobRecord } from '../../../shared/jobs'
import { GitInspectionView } from './git-inspection-view'
import { Button } from './ui/button'

/** Read-only view of a verified, saved checkout. No renderer-supplied paths. */
export function LinkedInspection({
  owner, name, path
}: { owner: string; name: string; path: string }) {
  const { t } = useTranslation()
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)

  useEffect(() => {
    let alive = true
    const unsubscribe = window.spindle.onJobsChanged((next) => { if (alive) setJobs(next) })
    void window.spindle.listJobs().then((initial) => {
      if (alive) setJobs(initial)
    }).catch(() => { if (alive) setError(true) })
    return () => { alive = false; unsubscribe() }
  }, [owner, name, path])

  const fullName = `${owner}/${name}`.toLowerCase()
  const matches = jobs.filter((job) =>
    job.kind === 'local-git-inspection' &&
    job.linkedRepository?.toLowerCase() === fullName && job.location === path)
  const latest = matches[0]
  const snapshot = matches.find((job) => job.phase === 'completed' && job.inspection)?.inspection
  const inspecting = !!latest && activeJob(latest.phase)
  const lastSync = jobs.find((job) =>
    ['local-git-clone', 'local-git-fetch', 'local-git-pull'].includes(job.kind) &&
    job.repository.toLowerCase() === fullName && job.phase === 'completed')
  const stale = !!snapshot && !!lastSync?.finishedAt &&
    lastSync.finishedAt > snapshot.inspectedAt

  async function inspect() {
    setBusy(true); setError(false)
    try {
      await window.spindle.inspectLinkedRepository(owner, name)
      window.dispatchEvent(new Event('spindle:activity:open'))
    } catch { setError(true) }
    finally { setBusy(false) }
  }

  return <section className="mt-4 border-t border-[var(--border)] pt-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="text-sm font-semibold">{t('gitSnapshotTitle')}</h3>
      <Button variant="secondary" size="sm" disabled={busy || inspecting}
        onClick={() => void inspect()}>
        <RotateCcw className="size-3.5"/>{t('gitSnapshotRefresh')}
      </Button>
    </div>
    {error && <p role="alert" className="mt-2 text-xs text-red-400">
      {t('localLinkError')}
    </p>}
    {inspecting && <p role="status" className="mt-2 text-xs text-[var(--muted)]">
      {t('gitSnapshotPending')}
    </p>}
    {!inspecting && latest && latest.phase !== 'completed' &&
      <p role="status" className="mt-2 text-xs text-[var(--muted)]">{t('gitSnapshotFailed')}</p>}
    {snapshot ? <>
      <GitInspectionView data={snapshot}/>
      <p className="mt-2 text-xs text-[var(--muted)]">
        {t(stale ? 'gitSnapshotMayBeStale' : 'gitSnapshotMayBeStale')}
      </p>
    </> : !inspecting &&
      <p className="mt-3 text-xs text-[var(--muted)]">{t('gitSnapshotNoData')}</p>}
  </section>
}
