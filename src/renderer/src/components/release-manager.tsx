import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { FileUp, Pencil, Plus, RefreshCw, Rocket, Tag, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Release } from '../../../shared/contracts'
import type {
  ReleaseDetails, ReleaseMutationRequest, ReleaseTagPreview
} from '../../../shared/releases'
import { activeJob } from '../../../shared/jobs'
import { Busy, Chip, ErrorState, ExternalGitHub } from './common'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { readableDate } from '../lib/utils'

type Action = 'create-draft' | 'edit-notes' | 'publish' | 'delete-release' | 'upload-asset'
interface Props {
  owner: string
  name: string
  releases: Release[] | undefined
  pending: boolean
  error: Error | null
  refresh(): void
}

export function ReleaseManager({ owner, name, releases, pending, error, refresh }: Props) {
  const { t, i18n } = useTranslation()
  const cache = useQueryClient()
  const [selected, setSelected] = useState<number | null>(null)
  const [action, setAction] = useState<Action | null>(null)
  const [tagName, setTagName] = useState('')
  const [tag, setTag] = useState<ReleaseTagPreview | null>(null)
  const [previewing, setPreviewing] = useState(false)
  const [title, setTitle] = useState('')
  const [notes, setNotes] = useState('')
  const [prerelease, setPrerelease] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState(false)

  const detail = useQuery({
    queryKey: ['release-detail', owner, name, selected],
    queryFn: () => window.spindle.getReleaseDetails(owner, name, selected!),
    enabled: selected !== null, retry: false
  })
  const current = detail.data

  useEffect(() => {
    if (selected !== null && releases && !releases.some(item => item.id === selected)) {
      setSelected(null)
    }
  }, [selected, releases])

  useEffect(() => {
    const handled = new Set<string>()
    return window.spindle.onJobsChanged((jobs) => {
      for (const job of jobs) {
        if (job.kind !== 'github-release' ||
            job.repository.toLowerCase() !== `${owner}/${name}`.toLowerCase() ||
            activeJob(job.phase) || handled.has(job.id)) continue
        handled.add(job.id)
        void cache.invalidateQueries({ queryKey: ['releases', owner, name] })
        void cache.invalidateQueries({ queryKey: ['release-detail', owner, name] })
      }
    })
  }, [owner, name, cache])

  function start(actionName: Action) {
    setFailure(false)
    setAction(actionName)
    if (actionName === 'create-draft') {
      setTagName('')
      setTag(null)
      setTitle('')
      setNotes('')
    } else if (current) {
      setTitle(current.name ?? current.tagName)
      setNotes(current.body)
      setPrerelease(current.prerelease)
    }
  }

  function close() { if (!busy) setAction(null) }

  async function preview() {
    setPreviewing(true)
    setFailure(false)
    setTag(null)
    try {
      const remote = await window.spindle.previewReleaseTag(owner, name, tagName)
      setTag(remote)
    } catch { setFailure(true) }
    finally { setPreviewing(false) }
  }

  async function submit() {
    if (!action || busy) return
    setBusy(true)
    setFailure(false)
    try {
      let request: ReleaseMutationRequest
      if (action === 'create-draft') {
        if (!tag || tag.name !== tagName) throw new Error('Tag needs verification')
        request = { action, tagName: tag.name, expectedTagOid: tag.tagOid, name: title, body: notes }
      } else {
        if (!current) throw new Error('Release details unavailable')
        const base = {
          tagName: current.tagName, expectedTagOid: current.tagOid,
          releaseId: current.id, expectedUpdatedAt: current.updatedAt
        }
        request = action === 'edit-notes'
          ? { action, ...base, name: title, body: notes }
          : action === 'publish'
            ? { action, ...base, prerelease }
            : { action, ...base }
      }
      const job = action === 'upload-asset'
        ? await window.spindle.pickReleaseAsset(owner, name, request)
        : await window.spindle.mutateRelease(owner, name, request)
      if (job) window.dispatchEvent(new Event('spindle:activity:open'))
      setAction(null)
    } catch { setFailure(true) }
    finally { setBusy(false) }
  }

  return <div className="panel space-y-4 p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h2 className="text-lg font-semibold">{t('releases')}</h2>
        <p className="text-xs text-[var(--muted)]">{t('releaseSeparate')}</p>
      </div>
      <div className="flex gap-2">
        <Button variant="secondary" size="sm" onClick={refresh}>
          <RefreshCw className="size-3.5"/>{t('refresh')}
        </Button>
        <Button size="sm" onClick={() => start('create-draft')}>
          <Plus className="size-3.5"/>{t('releaseCreateDraft')}
        </Button>
      </div>
    </div>
    {pending ? <Busy/> : error ? <ErrorState error={error} retry={refresh}/> :
      !releases?.length ? <p className="py-6 text-center text-sm text-[var(--muted)]">{t('noReleases')}</p> :
      <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
        {releases.map(item => <button key={item.id} type="button"
          aria-pressed={selected === item.id} onClick={() => setSelected(item.id)}
          className={`flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] ${selected === item.id ? 'bg-[var(--surface-2)]' : ''}`}>
          <Tag className="size-4 shrink-0 text-orange-400"/>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-medium">{item.name || item.tagName}</span>
            <span className="block truncate text-xs text-[var(--muted)]">{item.tagName} · {readableDate(item.publishedAt, i18n.language)}</span>
          </span>
          <Chip tone={item.draft ? undefined : item.prerelease ? 'orange' : 'green'}>
            {item.draft ? t('draft') : item.prerelease ? t('prerelease') : t('published')}
          </Chip>
        </button>)}
      </div>}
    {selected !== null && <section className="space-y-3 rounded-lg border border-[var(--border)] p-4">
      {detail.isPending ? <Busy/> : detail.isError ? <ErrorState error={detail.error} retry={() => void detail.refetch()}/> :
        current && <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-semibold">{current.name || current.tagName}</h3>
            <ExternalGitHub url={current.htmlUrl}/>
          </div>
          <p className="break-all font-mono text-xs">{t('releaseTag')}: {current.tagName}</p>
          <p className="break-all font-mono text-xs">{t('releaseCommit')}: {current.commitSha ?? t('releaseCommitUnavailable')}</p>
          <p className="break-all font-mono text-xs">{t('releaseTagObject')}: {current.tagOid ?? t('releaseCommitUnavailable')}</p>
          <p className="text-xs text-[var(--muted)]">{t('releaseAssets')}: {current.assets.length}</p>
          {current.assets.map(asset => <p key={asset.id} className="break-all text-xs text-[var(--muted)]">
            {asset.name} · {asset.size} B · {asset.state}
          </p>)}
          {current.body && <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-md bg-[var(--surface-2)] p-3 font-sans text-xs">{current.body}</pre>}
          {current.immutable && <p className="text-xs text-amber-500">{t('releaseImmutable')}</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" disabled={current.immutable} onClick={() => start('edit-notes')}>
              <Pencil className="size-3.5"/>{t('releaseEdit')}
            </Button>
            <Button variant="secondary" size="sm" disabled={current.immutable} onClick={() => start('upload-asset')}>
              <FileUp className="size-3.5"/>{t('releaseUpload')}
            </Button>
            {current.draft && <Button size="sm" disabled={current.immutable || !current.commitSha} onClick={() => start('publish')}>
              <Rocket className="size-3.5"/>{t('releasePublish')}
            </Button>}
            <Button variant="destructive" size="sm" disabled={current.immutable} onClick={() => start('delete-release')}>
              <Trash2 className="size-3.5"/>{t('releaseDelete')}
            </Button>
          </div>
        </>}
    </section>}
    <Dialog open={action !== null} onOpenChange={open => { if (!open) close() }}>
      <DialogContent className="max-h-[88vh] overflow-y-auto">
        <DialogTitle>{t(action === 'create-draft' ? 'releaseCreateDraft' : action === 'edit-notes' ? 'releaseEdit' :
          action === 'publish' ? 'releasePublish' : action === 'upload-asset' ? 'releaseUpload' : 'releaseDelete')}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
          {t(action === 'delete-release' ? 'releaseDeleteWarning' : action === 'upload-asset' ? 'releaseUploadWarning' :
            action === 'publish' ? 'releasePublishWarning' : 'releaseCreateWarning')}
        </DialogDescription>
        {action === 'create-draft' && <div className="mt-4 space-y-2">
          <label className="block text-xs" htmlFor="release-tag">{t('releaseTag')}</label>
          <div className="flex gap-2">
            <input id="release-tag" className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm"
              value={tagName} maxLength={100} disabled={busy || previewing}
              onChange={event => { setTagName(event.target.value); setTag(null) }}/>
            <Button size="sm" variant="secondary" disabled={previewing || !tagName} onClick={() => void preview()}>
              {t('releaseVerifyTag')}
            </Button>
          </div>
          {tag && <p className="break-all font-mono text-xs">{t('releaseCommit')}: {tag.commitSha}</p>}
        </div>}
        {(action === 'create-draft' || action === 'edit-notes') && <div className="mt-4 space-y-3">
          <label className="block text-xs" htmlFor="release-title">{t('releaseTitle')}</label>
          <input id="release-title" value={title} maxLength={150}
            onChange={event => setTitle(event.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm"/>
          <label className="block text-xs" htmlFor="release-notes">{t('releaseNotes')}</label>
          <textarea id="release-notes" value={notes} rows={6} maxLength={64000}
            onChange={event => setNotes(event.target.value)}
            className="w-full rounded-lg border border-[var(--border)] bg-transparent px-3 py-2 text-sm"/>
        </div>}
        {action && action !== 'create-draft' && current && <div className="mt-3 space-y-1">
          <p className="break-all text-xs">{t('releaseTag')}: {current.tagName}</p>
          <p className="break-all font-mono text-xs">{t('releaseCommit')}: {current.commitSha ?? t('releaseCommitUnavailable')}</p>
        </div>}
        {action === 'publish' && <label className="mt-4 flex items-center gap-2 text-sm">
          <input type="checkbox" checked={prerelease} onChange={e => setPrerelease(e.target.checked)}/>
          {t('releaseMarkPrerelease')}
        </label>}
        {failure && <p role="alert" className="mt-3 text-xs text-red-400">{t('releaseActionFailed')}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={close}>{t('cancel')}</Button>
          <Button variant={action === 'delete-release' ? 'destructive' : 'default'}
            disabled={busy || previewing || (action === 'create-draft' && (!tag || !title.trim())) ||
              (action === 'edit-notes' && !title.trim())}
            onClick={() => void submit()}>{t('releaseConfirm')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  </div>
}
