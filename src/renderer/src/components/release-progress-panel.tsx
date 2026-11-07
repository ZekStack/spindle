import { useEffect, useMemo, useState } from 'react'
import { Activity, RefreshCw, Square } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { JobRecord } from '../../../shared/jobs'
import type { ReleaseProgressSnapshot } from '../../../shared/release-progress'
import {
  RELEASE_POLL_MAX_CHECKS, RELEASE_POLL_MAX_MS, releasePollDelay
} from '../../../shared/release-progress'
import { Button } from './ui/button'
import { Chip, ExternalGitHub } from './common'

function releaseActivity(job: JobRecord): boolean {
  return job.kind === 'github-release' || job.kind === 'github-workflow-dispatch' ||
    (job.kind === 'local-git-tag' && job.tagOperation?.action === 'push')
}
function tagName(job: JobRecord): string {
  return job.releaseOperation?.tagName ??
    job.dispatchOperation?.tagName ?? job.tagOperation?.tag ?? ''
}
type Props = { owner: string; name: string }

/**
 * Observation is read-only. Each session has a hard limit and can be
 * restarted manually. No polling job is persisted or run in the background.
 */
export function ReleaseProgressPanel({ owner, name }: Props) {
  const { t, i18n } = useTranslation()
  const [jobs, setJobs] = useState<JobRecord[]>([])
  const [historyError, setHistoryError] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [snapshot, setSnapshot] = useState<ReleaseProgressSnapshot | null>(null)
  const [watching, setWatching] = useState(false)
  const [session, setSession] = useState(0)
  const [checks, setChecks] = useState(0)
  const [startedAt, setStartedAt] = useState(0)
  const [requestError, setRequestError] = useState(false)
  const [reading, setReading] = useState(false)

  useEffect(() => {
    let active = true
    setSelectedId(null)
    setSnapshot(null)
    setWatching(false)
    void window.spindle.listJobs().then(items => {
      if (active) { setJobs(items); setHistoryError(false) }
    }).catch(() => { if (active) setHistoryError(true) })
    const unsubscribe = window.spindle.onJobsChanged(items => {
      if (active) setJobs(items)
    })
    return () => { active = false; unsubscribe() }
  }, [owner, name])

  const matching = useMemo(() => jobs.filter(job =>
    releaseActivity(job) && job.repository.toLowerCase() ===
      `${owner}/${name}`.toLowerCase()).slice(0, 12), [jobs, owner, name])
  const current = matching.find(job => job.id === selectedId) ?? null

  // Do not substitute another job silently when the selected attempt leaves
  // the bounded Activity history; prompt the user to select a new attempt.
  function select(id: string) {
    setWatching(false)
    setSelectedId(id)
    setSnapshot(null)
    setChecks(0)
    setRequestError(false)
  }

  function inspect() {
    if (!current) return
    setSnapshot(null)
    setChecks(0)
    setRequestError(false)
    setStartedAt(Date.now())
    setSession(value => value + 1)
    setWatching(true)
  }

  const elapsed = startedAt > 0 ? Date.now() - startedAt : 0
  const exhausted = checks >= RELEASE_POLL_MAX_CHECKS ||
    (watching && elapsed >= RELEASE_POLL_MAX_MS)

  useEffect(() => {
    if (!watching || !selectedId || !startedAt) return
    if (checks >= RELEASE_POLL_MAX_CHECKS || Date.now() - startedAt >= RELEASE_POLL_MAX_MS) {
      setWatching(false)
      return
    }
    let cancelled = false
    const delay = checks === 0 ? 0 : releasePollDelay(checks)
    const timer = setTimeout(async () => {
      if (cancelled) return
      setReading(true)
      try {
        const result = await window.spindle.getReleaseProgress(selectedId)
        if (!cancelled) {
          setSnapshot(result)
          setRequestError(false)
          if (result.settled) setWatching(false)
        }
      } catch {
        if (!cancelled) setRequestError(true)
      } finally {
        if (!cancelled) {
          setReading(false)
          setChecks(previous => previous + 1)
        }
      }
    }, delay)
    return () => { cancelled = true; clearTimeout(timer) }
  }, [watching, selectedId, session, checks, startedAt])

  const stoppedAtLimit = !watching && startedAt > 0 && checks >= RELEASE_POLL_MAX_CHECKS &&
    !snapshot?.settled
  const observedTimeout = exhausted || stoppedAtLimit
  const statusKey = snapshot ? `progressOutcome_${snapshot.outcome}` : ''
  const run = snapshot?.run.matched ?? null
  const tagEvidence = snapshot?.tag.state ?? 'unavailable'
  const releaseEvidence = snapshot?.release.state ?? 'unavailable'
  const runEvidence = snapshot?.run.correlation ?? 'none'
  const tone = snapshot?.outcome === 'published' || snapshot?.outcome === 'release-deleted'
    ? 'green' : snapshot?.outcome === 'failed' || tagEvidence === 'changed'
      ? 'orange' : undefined

  return <section className="panel space-y-3 p-5">
    <div>
      <h3 className="flex items-center gap-2 text-base font-semibold">
        <Activity className="size-4"/>{t('progressTitle')}
      </h3>
      <p className="mt-1 text-xs text-[var(--muted)]">{t('progressHint')}</p>
    </div>
    {historyError && <p role="alert" className="text-xs text-red-400">{t('progressHistoryFailed')}</p>}
    {!historyError && matching.length === 0 &&
      <p className="text-sm text-[var(--muted)]">{t('progressNoAttempts')}</p>}
    {matching.length > 0 && <div className="flex flex-wrap items-center gap-2">
      <label htmlFor="release-progress-attempt" className="text-xs">{t('progressAttempt')}</label>
      <select id="release-progress-attempt" value={selectedId ?? ''}
        onChange={event => select(event.target.value)}
        className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-sm">
        <option value="">{t('progressChoose')}</option>
        {matching.map(job => <option key={job.id} value={job.id}>
          {tagName(job)} · {job.kind === 'github-workflow-dispatch' ? t('strategyDispatch')
            : job.kind === 'local-git-tag' ? t('strategyTagPush') : t('strategyApi')}
          {' · '}{job.phase} · {new Date(job.requestedAt).toLocaleString(i18n.language)}
        </option>)}
      </select>
      <Button size="sm" disabled={!current || reading} onClick={inspect}>
        <RefreshCw className="size-3.5"/>{t('progressInspect')}
      </Button>
      {watching && <Button variant="secondary" size="sm" onClick={() => setWatching(false)}>
        <Square className="size-3.5"/>{t('progressStop')}
      </Button>}
    </div>}
    {current && <div className="space-y-3 rounded-lg border border-[var(--border)] p-4">
      <div className="flex flex-wrap gap-2 text-xs">
        <Chip>{current.phase}</Chip>
        <span className="break-all font-mono">{tagName(current)}</span>
      </div>
      {watching && <p className="text-xs text-[var(--muted)]">
        {t('progressWatching', { count: checks, maximum: RELEASE_POLL_MAX_CHECKS })}
      </p>}
      {requestError && <p role="alert" className="text-xs text-red-400">{t('progressReadFailed')}</p>}
      {snapshot && <>
        <div className="flex flex-wrap items-center gap-2">
          <Chip tone={tone}>{observedTimeout && !snapshot.settled
            ? t('progressTimedOut') : t(statusKey)}</Chip>
          <span className="text-xs text-[var(--muted)]">
            {t('progressChecked')}: {new Date(snapshot.checkedAt).toLocaleTimeString(i18n.language)}
          </span>
        </div>
        <dl className="grid gap-2 text-xs sm:grid-cols-2">
          <div><dt className="text-[var(--muted)]">{t('progressTagState')}</dt>
            <dd>{t(`progressTag_${tagEvidence}`)}</dd></div>
          <div><dt className="text-[var(--muted)]">{t('progressReleaseState')}</dt>
            <dd>{t(`progressRelease_${releaseEvidence}`)}</dd></div>
          <div><dt className="text-[var(--muted)]">{t('progressRunMatch')}</dt>
            <dd>{t(`progressRun_${runEvidence}`)}</dd></div>
          <div><dt className="text-[var(--muted)]">{t('releaseAssets')}</dt>
            <dd>{snapshot.release.assetCount}</dd></div>
        </dl>
        {snapshot.tag.actualOid && <p className="break-all font-mono text-xs">
          {t('releaseTagObject')}: {snapshot.tag.actualOid}
        </p>}
        {snapshot.tag.commitSha && <p className="break-all font-mono text-xs">
          {t('releaseCommit')}: {snapshot.tag.commitSha}
        </p>}
        {snapshot.run.truncated && <p className="text-xs text-amber-400">
          {t('progressRunTruncated')}
        </p>}
        {snapshot.run.correlation === 'ambiguous' && <p className="text-xs text-amber-400">
          {t('progressAmbiguous', { count: snapshot.run.candidateCount })}
        </p>}
        {run && <div className="flex flex-wrap items-center gap-2 text-xs">
          <span>#{run.id} · {run.status} · {run.conclusion ?? t('progressStillRunning')}</span>
          <ExternalGitHub url={run.htmlUrl}/>
          {snapshot.run.correlation === 'candidate' &&
            <span className="text-amber-400">{t('progressCandidateWarning')}</span>}
        </div>}
        {snapshot.release.htmlUrl && <div className="flex items-center gap-2 text-xs">
          <span>{t('releases')}</span><ExternalGitHub url={snapshot.release.htmlUrl}/>
        </div>}
        {snapshot.release.assetNames.length > 0 && <p className="break-all text-xs text-[var(--muted)]">
          {snapshot.release.assetNames.join(' · ')}
        </p>}
        {snapshot.recovery !== 'none' && <p className="text-xs text-amber-400">
          {t(`progressRecovery_${snapshot.recovery}`)}
        </p>}
        {!snapshot.settled && <p className="text-xs text-[var(--muted)]">
          {t('progressNoDuplicate')}
        </p>}
      </>}
      {observedTimeout && !snapshot?.settled && <p role="status" className="text-xs text-amber-400">
        {t('progressDeadline')}
      </p>}
      {!snapshot && !reading && !watching && <p className="text-xs text-[var(--muted)]">
        {t('progressManual')}
      </p>}
    </div>}
  </section>
}
