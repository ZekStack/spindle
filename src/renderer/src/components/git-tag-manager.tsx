import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Download, Plus, RefreshCw, Send, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { validateTagName, type GitTagEntry, type TagAction, type TagMode, type TagMutationRequest } from '../../../shared/tags'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

type DeleteAction = Exclude<TagAction, 'create'>
const actionLabel: Record<TagAction, string> = {
  create: 'tagsCreate',
  push: 'tagsPush',
  'delete-local': 'tagsDeleteLocal',
  'delete-origin': 'tagsDeleteOrigin',
  'delete-both': 'tagsDeleteBoth'
}

/** Native-linked Git refs only. Every remote mutation requires a fresh explicit confirmation. */
export function GitTagManager({ owner, name, path }: { owner: string; name: string; path: string }) {
  const { t } = useTranslation()
  const client = useQueryClient()
  const queryKey = ['git-tags', owner, name, path] as const
  const query = useQuery({ queryKey, queryFn: () => window.spindle.listLinkedTags(owner, name),
    retry: false })
  const [createOpen, setCreateOpen] = useState(false)
  const [newName, setNewName] = useState('')
  const [mode, setMode] = useState<TagMode>('annotated')
  const [message, setMessage] = useState('')
  const [selected, setSelected] = useState<TagMutationRequest | null>(null)
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const seen = new Set<string>()
    return window.spindle.onJobsChanged((jobs) => {
      const completed = jobs.filter(job => job.kind === 'local-git-tag' &&
        job.repository.toLowerCase() === `${owner}/${name}`.toLowerCase() &&
        ['completed', 'partial', 'failed', 'cancelled'].includes(job.phase))
      for (const job of completed) {
        if (seen.has(job.id)) continue
        seen.add(job.id)
        void client.invalidateQueries({ queryKey })
      }
    })
  }, [client, owner, name, path])

  function request(action: DeleteAction, item: GitTagEntry) {
    setFailed(false)
    const selected: TagMutationRequest = { action, tag: item.name,
      ...(action === 'push' || action === 'delete-local' || action === 'delete-both'
        ? { expectedLocalOid: item.local!.oid } : {}),
      ...(action === 'delete-origin' || action === 'delete-both'
        ? { expectedOriginOid: item.origin!.oid } : {}) }
    setSelected(selected)
  }

  const selectedEntry = selected ? query.data?.entries.find(entry => entry.name === selected.tag) : null
  const remoteAvailable = query.data?.originState === 'available'
  let validName = false
  try { validateTagName(newName); validName = true } catch { /* Form shows the error. */ }
  const localNameUsed = query.data?.entries.some(entry => entry.name === newName && entry.local)
  const createReady = validName && !localNameUsed && !!query.data?.head &&
    (mode === 'lightweight' || !!message.trim() && message.length <= 1000)

  async function start(operation: TagMutationRequest) {
    setBusy(true)
    setFailed(false)
    try {
      await window.spindle.mutateLinkedTag(owner, name, operation)
      setSelected(null)
      setCreateOpen(false)
      setNewName('')
      setMessage('')
      window.dispatchEvent(new Event('spindle:activity:open'))
    } catch { setFailed(true) }
    finally { setBusy(false) }
  }

  return <section className="mt-5 border-t border-[var(--border)] pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <h3 className="text-sm font-semibold">{t('tagsTitle')}</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">{t('tagsDescription')}</p>
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="secondary" disabled={busy || query.isFetching}
          onClick={() => void query.refetch()}>
          <RefreshCw className="size-3.5"/>{t('tagsRefresh')}
        </Button>
        <Button size="sm" disabled={busy || !query.data?.head}
          onClick={() => { setFailed(false); setCreateOpen(true) }}>
          <Plus className="size-3.5"/>{t('tagsCreate')}
        </Button>
      </div>
    </div>
    {query.isFetching && <p role="status" className="mt-3 text-xs text-[var(--muted)]">
      {t('tagsLoading')}
    </p>}
    {query.isError && <p role="alert" className="mt-3 text-xs text-red-400">
      {t('tagsReadFailed')}
    </p>}
    {query.data && <>
      <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-[var(--muted)]">
        <span>{t('gitSnapshotLocalTags')}: {query.data.localTotal}</span>
        <span>{t('gitSnapshotRemoteTags')}: {remoteAvailable ? query.data.originTotal : '—'}</span>
        <span>{remoteAvailable ? t('tagsOriginOnline') :
          t(query.data.originError === 'auth' ? 'localSafety_auth'
            : query.data.originError === 'network' ? 'localSafety_network' : 'tagsOriginUnavailable')}</span>
      </div>
      {query.data.entries.length === 0 ?
        <p className="mt-3 text-sm text-[var(--muted)]">{t('tagsEmpty')}</p> :
        <div className="mt-3 max-h-96 divide-y divide-[var(--border)] overflow-y-auto rounded-lg border border-[var(--border)]">
          {query.data.entries.map(item => <div key={item.name}
            className="flex flex-wrap items-center gap-2 px-3 py-2">
            <div className="min-w-32 flex-1">
              <p className="break-all font-mono text-xs font-medium">{item.name}</p>
              <p className="mt-1 text-[11px] text-[var(--muted)]">
                {item.local ? t(item.local.kind === 'annotated' ? 'tagsAnnotated' : 'tagsLightweight')
                  : t('tagsNotLocal')} · {remoteAvailable
                    ? item.origin ? t('tagsOriginExists') : t('tagsNotOnOrigin')
                    : t('tagsOriginUnknown')}
              </p>
            </div>
            {item.local && !item.origin && remoteAvailable &&
              <Button size="sm" variant="secondary" disabled={busy}
                onClick={() => request('push', item)}>
                <Send className="size-3.5"/>{t('tagsPush')}
              </Button>}
            {item.local && <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => request('delete-local', item)}>
              <Trash2 className="size-3.5"/>{t('tagsDeleteLocal')}
            </Button>}
            {item.origin && remoteAvailable && <Button size="sm" variant="ghost" disabled={busy}
              onClick={() => request('delete-origin', item)}>
              <Trash2 className="size-3.5"/>{t('tagsDeleteOrigin')}
            </Button>}
            {item.local && item.origin && remoteAvailable &&
              <Button size="sm" variant="destructive" disabled={busy}
                onClick={() => request('delete-both', item)}>
                <Trash2 className="size-3.5"/>{t('tagsDeleteBoth')}
              </Button>}
          </div>)}
        </div>}
      {query.data.localTotal + (remoteAvailable ? query.data.originTotal : 0) > query.data.entries.length &&
        <p className="mt-2 text-xs text-[var(--muted)]">{t('tagsTruncated')}</p>}
      {!query.data.head &&
        <p className="mt-2 text-xs text-[var(--muted)]">{t('tagsNoCommit')}</p>}
    </>}
    <Dialog open={createOpen} onOpenChange={open => { if (!busy) setCreateOpen(open) }}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">{t('tagsCreate')}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
          {t('tagsCreateDescription')}
        </DialogDescription>
        <label className="mt-4 block text-sm">
          {t('tagsName')}
          <input className="field mt-2 w-full" value={newName}
            autoComplete="off" spellCheck={false} maxLength={100}
            onChange={event => setNewName(event.target.value)}/>
        </label>
        {newName && !validName && <p role="alert" className="mt-1 text-xs text-red-400">
          {t('tagsInvalidName')}
        </p>}
        {localNameUsed && <p role="alert" className="mt-1 text-xs text-red-400">
          {t('tagsAlreadyLocal')}
        </p>}
        <label className="mt-4 block text-sm">
          {t('tagsType')}
          <select className="field mt-2 w-full" value={mode}
            onChange={event => setMode(event.target.value as TagMode)}>
            <option value="annotated">{t('tagsAnnotated')}</option>
            <option value="lightweight">{t('tagsLightweight')}</option>
          </select>
        </label>
        {mode === 'annotated' && <label className="mt-4 block text-sm">
          {t('tagsMessage')}
          <textarea className="field mt-2 w-full" value={message} rows={3}
            maxLength={1000} onChange={event => setMessage(event.target.value)}/>
        </label>}
        <p className="mt-3 break-all text-xs text-[var(--muted)]">
          {t('tagsTarget')}: {query.data?.head ?? '—'}
        </p>
        <p className="mt-2 text-xs text-[var(--muted)]">{t('tagsCreateLocalOnly')}</p>
        {failed && <p role="alert" className="mt-2 text-xs text-red-400">{t('tagsSubmitFailed')}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => setCreateOpen(false)}>
            {t('localCancel')}
          </Button>
          <Button disabled={busy || !createReady} onClick={() => {
            if (query.data?.head) void start({
              action: 'create', tag: newName, mode, expectedHead: query.data.head,
              ...(mode === 'annotated' ? { message } : {})
            })
          }}>{t('tagsCreate')}</Button>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={selected !== null} onOpenChange={open => { if (!open && !busy) setSelected(null) }}>
      <DialogContent>
        <DialogTitle className="text-lg font-semibold">
          {selected ? t(actionLabel[selected.action]) : t('tagsTitle')}
        </DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
          {t('tagsConfirmDescription')}
        </DialogDescription>
        {selected && <>
          <p className="mt-3 break-all font-mono text-sm font-semibold">{selected.tag}</p>
          {selected.expectedLocalOid && <p className="mt-2 break-all text-xs text-[var(--muted)]">
            {t('tagsLocalObject')}: {selected.expectedLocalOid}
          </p>}
          {selected.expectedOriginOid && <p className="mt-2 break-all text-xs text-[var(--muted)]">
            {t('tagsOriginObject')}: {selected.expectedOriginOid}
          </p>}
          <p className="mt-3 text-xs text-[var(--muted)]">
            {t(selected.action === 'delete-both' ? 'tagsCombinedWarning'
              : selected.action === 'delete-origin' ? 'tagsOriginWarning'
                : selected.action === 'delete-local' ? 'tagsLocalWarning' : 'tagsPushWarning')}
          </p>
          {selectedEntry === undefined && <p className="mt-2 text-xs text-amber-400">
            {t('tagsChangedSincePreview')}
          </p>}
        </>}
        {failed && <p role="alert" className="mt-3 text-xs text-red-400">{t('tagsSubmitFailed')}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={() => setSelected(null)}>
            {t('localCancel')}
          </Button>
          {selected && <Button variant={selected.action.startsWith('delete-') ? 'destructive' : 'default'}
            disabled={busy} onClick={() => void start(selected)}>
            {t(actionLabel[selected.action])}
          </Button>}
        </div>
      </DialogContent>
    </Dialog>
  </section>
}
