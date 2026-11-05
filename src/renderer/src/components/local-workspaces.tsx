import { useEffect, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { ArrowDown, Download, FolderGit2, FolderOpen, Link2, RotateCcw, Trash2, Unlink } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { LocalWorkspace } from '../../../shared/contracts'
import type { PullReadiness } from '../../../shared/git-safety'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { LinkedInspection } from './linked-inspection'

const KEY = ['local-workspaces'] as const

/** Explicitly stored directories, independent of GitHub saved organizations. */
export function WorkspaceDirectories() {
  const { t } = useTranslation()
  const client = useQueryClient()
  const query = useQuery({ queryKey: KEY, queryFn: () => window.spindle.getLocalWorkspaces() })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [remove, setRemove] = useState<string | null>(null)
  async function add() {
    setBusy(true); setError(false)
    try {
      const updated = await window.spindle.pickWorkspaceRoot()
      if (updated) client.setQueryData(KEY, updated)
    } catch { setError(true) }
    finally { setBusy(false) }
  }
  async function removeRoot() {
    if (!remove) return
    setBusy(true); setError(false)
    try {
      const updated = await window.spindle.removeWorkspaceRoot(remove)
      client.setQueryData(KEY, updated)
      setRemove(null)
    } catch { setError(true) }
    finally { setBusy(false) }
  }
  return <section className="panel min-w-0 overflow-hidden">
    <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[var(--border)] px-5 py-4">
      <div>
        <h2 className="font-semibold">{t('localRootsTitle')}</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">{t('localRootsHint')}</p>
      </div>
      <Button size="sm" variant="secondary" disabled={busy}
        onClick={() => void add()}>
        <FolderOpen className="size-3.5"/>{t('localAddRoot')}
      </Button>
    </div>
    {error && <p role="alert" className="px-5 pt-3 text-xs text-red-400">{t('localRootError')}</p>}
    {query.isError && <p role="alert" className="p-5 text-xs text-red-400">{t('localSettingsError')}</p>}
    {query.isLoading && <p className="p-5 text-sm text-[var(--muted)]">{t('loading')}</p>}
    {query.data && <div className="divide-y divide-[var(--border)]">
      {query.data.roots.length ? query.data.roots.map((root) =>
        <div key={root} className="flex items-center gap-3 px-5 py-3">
          <FolderGit2 className="size-4 shrink-0 text-orange-500"/>
          <span className="min-w-0 flex-1 break-all text-xs text-[var(--muted)]">{root}</span>
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setRemove(root)}
            aria-label={t('localRemoveRoot')} title={t('localRemoveRoot')}>
            <Trash2 className="size-4"/>
          </Button>
        </div>)
        : <p className="px-5 py-4 text-sm text-[var(--muted)]">{t('localNoRoots')}</p>}
      {query.data.repositories.length > 0 && <div className="px-5 py-4">
        <h3 className="mb-2 text-xs font-semibold text-[var(--muted)]">{t('localLinkedRepos')}</h3>
        <div className="space-y-2">
          {query.data.repositories.map(({ repository, path }) => {
            const [owner, name] = repository.split('/')
            return <div key={repository.toLowerCase()} className="flex min-w-0 items-center gap-2 text-xs">
              <Link2 className="size-3.5 shrink-0 text-orange-500"/>
              <Link to="/repo/$owner/$name" params={{ owner, name }}
                className="font-medium text-[var(--fg)] hover:text-orange-400">{repository}</Link>
              <span className="min-w-0 truncate text-[var(--muted)]" title={path}>{path}</span>
            </div>
          })}
        </div>
      </div>}
    </div>}
    <Dialog open={remove !== null} onOpenChange={(open) => { if (!open) setRemove(null) }}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">{t('localRemoveRoot')}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted)]">{t('localRemoveRootDetails')}</DialogDescription>
        <p className="mt-3 break-all text-xs text-[var(--muted)]">{remove}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setRemove(null)}>{t('localCancel')}</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void removeRoot()}>
            {t('localRemoveRoot')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </section>
}

/** Repository-specific checkout association; replacing never moves a folder. */
export function RepositoryCheckout({ owner, name }: { owner: string; name: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const query = useQuery({ queryKey: KEY, queryFn: () => window.spindle.getLocalWorkspaces() })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  const [unlinkOpen, setUnlinkOpen] = useState(false)
  const [cloneOpen, setCloneOpen] = useState(false)
  const [cloneRoot, setCloneRoot] = useState('')
  const [pullOpen, setPullOpen] = useState(false)
  const [pullPreview, setPullPreview] = useState<PullReadiness | null>(null)
  const [pullPreviewFailed, setPullPreviewFailed] = useState(false)
  const [pullPreviewRevision, setPullPreviewRevision] = useState(0)
  const linked = query.data?.repositories.find((item) =>
    item.repository.toLowerCase() === `${owner}/${name}`.toLowerCase())

  // The preview is advisory. Main repeats the same guards at job execution.
  useEffect(() => {
    if (!pullOpen) return
    let current = true
    setPullPreview(null)
    setPullPreviewFailed(false)
    void window.spindle.previewLinkedPull(owner, name).then((status) => {
      if (current) setPullPreview(status)
    }).catch(() => { if (current) setPullPreviewFailed(true) })
    return () => { current = false }
  }, [pullOpen, owner, name, pullPreviewRevision])

  // Cloning links a checkout only after Git and origin verification complete.
  useEffect(() => window.spindle.onJobsChanged((jobs) => {
    if (jobs.some((job) => job.kind === 'local-git-clone' &&
      job.repository.toLowerCase() === `${owner}/${name}`.toLowerCase() &&
      job.phase === 'completed')) {
      void client.invalidateQueries({ queryKey: KEY })
    }
  }), [client, owner, name])

  async function startJob(operation: () => Promise<unknown>) {
    setBusy(true); setError(false)
    try {
      await operation()
      setCloneOpen(false)
      setPullOpen(false)
      window.dispatchEvent(new Event('spindle:activity:open'))
    } catch { setError(true) }
    finally { setBusy(false) }
  }

  async function mutate(operation: () => Promise<LocalWorkspace | null>) {
    setBusy(true); setError(false)
    try {
      const updated = await operation()
      if (updated) client.setQueryData(KEY, updated)
    } catch { setError(true) }
    finally { setBusy(false) }
  }
  async function unlink() {
    setBusy(true); setError(false)
    try {
      const updated = await window.spindle.unlinkRepositoryFolder(owner, name)
      client.setQueryData(KEY, updated)
      setUnlinkOpen(false)
    } catch { setError(true) }
    finally { setBusy(false) }
  }

  return <div className="panel p-5 sm:col-span-2">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="font-semibold">{t('localCheckoutTitle')}</h2>
        <p className="mt-1 text-xs text-[var(--muted)]">{t('localCheckoutHint')}</p>
      </div>
      <Button variant="secondary" size="sm" disabled={busy || query.isLoading || query.isError}
        onClick={() => void mutate(() => window.spindle.linkRepositoryFolder(owner, name))}>
        <FolderOpen className="size-3.5"/>{t(linked ? 'localRelink' : 'localLink')}
      </Button>
    </div>
    {query.isError && <p role="alert" className="mt-3 text-xs text-red-400">{t('localSettingsError')}</p>}
    {error && <p role="alert" className="mt-3 text-xs text-red-400">{t('localLinkError')}</p>}
    {!linked && <div className="mt-4 flex flex-wrap items-center gap-2">
      <Button variant="secondary" size="sm"
        disabled={busy || query.isLoading || query.isError || !query.data?.roots.length}
        onClick={() => {
          setCloneRoot(query.data?.roots[0] ?? '')
          setCloneOpen(true)
        }}>
        <Download className="size-3.5"/>{t('localClone')}
      </Button>
      {!query.data?.roots.length && <span className="text-xs text-[var(--muted)]">
        {t('localCloneNeedsRoot')}
      </span>}
    </div>}
    {linked ? <>
      <p className="mt-4 break-all text-sm text-[var(--muted)]">{linked.path}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" disabled={busy}
          onClick={() => void startJob(() => window.spindle.syncLinkedRepository(owner, name, 'fetch'))}>
          <Download className="size-3.5"/>{t('localFetch')}
        </Button>
        <Button variant="secondary" size="sm" disabled={busy} onClick={() => setPullOpen(true)}>
          <ArrowDown className="size-3.5"/>{t('localPull')}
        </Button>
        <Button variant="ghost" size="sm" disabled={busy} onClick={() => setUnlinkOpen(true)}>
          <Unlink className="size-3.5"/>{t('localUnlink')}
        </Button>
      </div>
      <LinkedInspection key={linked.path} owner={owner} name={name} path={linked.path}/>
    </> : <p className="mt-3 text-sm text-[var(--muted)]">{t('localNoCheckout')}</p>}
    <Dialog open={cloneOpen} onOpenChange={setCloneOpen}>
      <DialogContent>
        <DialogTitle className="font-semibold">{t('localClone')}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
          {t('localCloneDetails')}
        </DialogDescription>
        <label className="mt-4 block text-sm">
          {t('localCloneRoot')}
          <select className="field mt-2 w-full" value={cloneRoot}
            onChange={(event) => setCloneRoot(event.target.value)}>
            {(query.data?.roots ?? []).map((root) => <option key={root} value={root}>{root}</option>)}
          </select>
        </label>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => setCloneOpen(false)}>{t('localCancel')}</Button>
          <Button disabled={busy || !cloneRoot} onClick={() =>
            void startJob(() => window.spindle.cloneRepository(owner, name, cloneRoot))}>
            {t('localClone')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={pullOpen} onOpenChange={setPullOpen}>
      <DialogContent>
        <DialogTitle className="font-semibold">{t('localPull')}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
          {t('localPullDetails')}
        </DialogDescription>
        <div className="mt-4 rounded-lg border border-[var(--border)] p-3">
          {!pullPreview && !pullPreviewFailed && <p role="status" className="text-sm text-[var(--muted)]">
            {t('localPullSafetyChecking')}
          </p>}
          {pullPreviewFailed && <p role="alert" className="text-sm text-red-400">
            {t('localPullSafetyError')}
          </p>}
          {pullPreview && <div className="space-y-2">
            <p role="status" className={pullPreview.ready ? 'text-sm text-[var(--fg)]' : 'text-sm text-amber-400'}>
              {pullPreview.ready
                ? `${t('localPullSafetyReady')} ${pullPreview.branch ?? '—'}`
                : t('localPullSafetyBlocked')}
            </p>
            {pullPreview.reason && <p className="text-sm text-[var(--muted)]">
              {t(`localSafety_${pullPreview.reason}`)}
            </p>}
            <p className="text-xs text-[var(--muted)]">
              {t('localPullSafetyCounts')}: {[
                pullPreview.staged, pullPreview.unstaged,
                pullPreview.untracked, pullPreview.conflicted
              ].join(' / ')}
            </p>
            {pullPreview.ahead !== null && pullPreview.behind !== null &&
              <p className="text-xs text-[var(--muted)]">
                {t('gitSnapshotAhead')}: {pullPreview.ahead} · {t('gitSnapshotBehind')}: {pullPreview.behind}
              </p>}
          </div>}
        </div>
        <p className="mt-3 text-xs text-[var(--muted)]">{t('localPullSafetyAdvisory')}</p>
        <div className="mt-5 flex flex-wrap justify-end gap-2">
          <Button variant="ghost" size="sm" disabled={busy}
            onClick={() => setPullPreviewRevision((value) => value + 1)}>
            <RotateCcw className="size-3.5"/>{t('localPullSafetyRefresh')}
          </Button>
          <Button variant="secondary" disabled={busy} onClick={() => setPullOpen(false)}>
            {t('localCancel')}
          </Button>
          {pullPreview && !pullPreview.ready && !!pullPreview.reason &&
            ['dirty-worktree', 'conflicted', 'detached-head', 'upstream-missing',
              'upstream-mismatch', 'diverged'].includes(pullPreview.reason) &&
            <Button variant="secondary" disabled={busy} onClick={() =>
              void startJob(() => window.spindle.syncLinkedRepository(owner, name, 'fetch'))}>
              <Download className="size-3.5"/>{t('localPullSafetyFetchOnly')}
            </Button>}
          {pullPreview?.ready && <Button disabled={busy} onClick={() =>
            void startJob(() => window.spindle.syncLinkedRepository(owner, name, 'pull'))}>
            {t('localPull')}
          </Button>}
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={unlinkOpen} onOpenChange={setUnlinkOpen}>
      <DialogContent>
        <DialogTitle className="font-semibold">{t('localUnlink')}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted)]">{t('localUnlinkDetails')}</DialogDescription>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setUnlinkOpen(false)}>{t('localCancel')}</Button>
          <Button variant="destructive" disabled={busy} onClick={() => void unlink()}>{t('localUnlink')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
}
