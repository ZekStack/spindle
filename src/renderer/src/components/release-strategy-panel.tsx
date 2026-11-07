import { useEffect, useState } from 'react'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { GitBranch, RefreshCw, Settings2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { ReleaseStrategy } from '../../../shared/release-strategies'
import type { GitTagEntry } from '../../../shared/tags'
import type { ReleaseTagPreview } from '../../../shared/releases'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

type Props = { owner: string; name: string; onApiCreate(): void }
type PendingTag = { mode: 'tag-push'; entry: GitTagEntry } |
  { mode: 'dispatch'; preview: ReleaseTagPreview }

export function ReleaseStrategyPanel({ owner, name, onApiCreate }: Props) {
  const { t } = useTranslation()
  const cache = useQueryClient()
  const repo = `${owner}/${name}`
  const config = useQuery({
    queryKey: ['release-strategy', owner, name],
    queryFn: () => window.spindle.getReleaseStrategy(owner, name)
  })
  const details = useQuery({
    queryKey: ['repo', owner, name],
    queryFn: () => window.spindle.getRepository(owner, name)
  })
  const [editing, setEditing] = useState(false)
  const [mode, setMode] = useState<ReleaseStrategy['kind']>('api')
  const [workflowId, setWorkflowId] = useState(0)
  const [ref, setRef] = useState('')
  const [trigger, setTrigger] = useState(false)
  const [tagName, setTagName] = useState('')
  const [confirmedTag, setConfirmedTag] = useState<PendingTag | null>(null)
  const [inputsText, setInputsText] = useState('{}')
  const [inspecting, setInspecting] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [failure, setFailure] = useState('')
  const workflows = useQuery({
    queryKey: ['release-workflows', owner, name],
    queryFn: () => window.spindle.listReleaseWorkflows(owner, name),
    enabled: editing || (config.data?.kind !== undefined && config.data.kind !== 'api'),
    staleTime: 30_000
  })
  const active = workflows.data?.items.filter(item => item.state === 'active') ?? []
  const strategy = config.data

  useEffect(() => {
    if (!editing || !strategy) return
    setMode(strategy.kind)
    setWorkflowId(strategy.kind === 'api' ? 0 : strategy.workflowId)
    setRef(strategy.kind === 'dispatch' ? strategy.ref : (details.data?.defaultBranch ?? ''))
  }, [editing, strategy, details.data?.defaultBranch])

  const save = useMutation({
    mutationFn: async () => {
      const choice: ReleaseStrategy = mode === 'api' ? { kind: 'api' }
        : mode === 'tag-push' ? { kind: 'tag-push', workflowId }
          : { kind: 'dispatch', workflowId, ref: ref.trim() }
      return window.spindle.saveReleaseStrategy(owner, name, choice)
    },
    onSuccess: value => {
      cache.setQueryData(['release-strategy', owner, name], value)
      setEditing(false)
      setFailure('')
    },
    onError: () => setFailure(t('strategySaveFailed'))
  })

  function openTrigger() {
    if (strategy?.kind === 'api') { onApiCreate(); return }
    setTagName('')
    setConfirmedTag(null)
    setInputsText('{}')
    setFailure('')
    setTrigger(true)
  }
  function closeTrigger() { if (!submitting && !inspecting) setTrigger(false) }

  async function previewTag() {
    if (!strategy || strategy.kind === 'api') return
    setInspecting(true)
    setConfirmedTag(null)
    setFailure('')
    try {
      if (strategy.kind === 'tag-push') {
        const tags = await window.spindle.listLinkedTags(owner, name)
        if (tags.originState !== 'available') throw new Error('Origin state unavailable')
        const item = tags.entries.find(value => value.name === tagName)
        if (!item?.local || item.origin) throw new Error('Local unpublished tag required')
        setConfirmedTag({ mode: 'tag-push', entry: item })
      } else {
        const preview = await window.spindle.previewReleaseTag(owner, name, tagName)
        setConfirmedTag({ mode: 'dispatch', preview })
      }
    } catch { setFailure(t(strategy.kind === 'tag-push' ? 'strategyTagMissing' : 'strategyPreviewFailed')) }
    finally { setInspecting(false) }
  }

  async function execute() {
    if (!strategy || strategy.kind === 'api' || !confirmedTag || submitting) return
    setFailure('')
    setSubmitting(true)
    try {
      if (strategy.kind === 'tag-push' && confirmedTag.mode === 'tag-push') {
        await window.spindle.pushReleaseTag(owner, name,
          confirmedTag.entry.name, confirmedTag.entry.local!.oid)
      } else if (strategy.kind === 'dispatch' && confirmedTag.mode === 'dispatch') {
        // Workflow input values may be secret: only submit transiently to main.
        const inputs: unknown = JSON.parse(inputsText)
        if (!inputs || typeof inputs !== 'object' || Array.isArray(inputs)) {
          throw new Error('Invalid inputs')
        }
        await window.spindle.dispatchReleaseWorkflow(owner, name, {
          workflowId: strategy.workflowId, ref: strategy.ref,
          tagName: confirmedTag.preview.name, expectedTagOid: confirmedTag.preview.tagOid,
          inputs: inputs as Record<string, string>
        })
      } else throw new Error('Release strategy changed')
      setTrigger(false)
      window.dispatchEvent(new Event('spindle:activity:open'))
      void cache.invalidateQueries({ queryKey: ['releases', owner, name] })
    } catch { setFailure(t('strategyActionFailed')) }
    finally { setSubmitting(false) }
  }

  const selected = active.find(item => item.id === workflowId)
  const ready = mode === 'api' || !!selected && (mode !== 'dispatch' || ref.trim().length > 0)
  const activeName = strategy?.kind === 'api' ? '' :
    workflows.data?.items.find(item => item.id === strategy?.workflowId)?.name ?? t('strategyWorkflowUnknown')
  const confirmed = confirmedTag &&
    (confirmedTag.mode === 'tag-push' ? confirmedTag.entry.name === tagName
      : confirmedTag.preview.name === tagName)

  return <section className="space-y-3 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-semibold">{t('strategyTitle')}</h3>
        <p className="mt-1 text-xs text-[var(--muted)]">
          {config.isPending ? t('strategyLoading') : config.isError ? t('strategyLoadFailed')
            : `${t(strategy?.kind === 'tag-push' ? 'strategyTagPush'
              : strategy?.kind === 'dispatch' ? 'strategyDispatch' : 'strategyApi')}${activeName ? ` · ${activeName}` : ''}`}
        </p>
        {strategy?.kind === 'dispatch' && <p className="break-all text-xs text-[var(--muted)]">
          <GitBranch className="mr-1 inline size-3"/>{strategy.ref}
        </p>}
      </div>
      <Button variant="secondary" size="sm" disabled={config.isPending}
        onClick={() => { setFailure(''); setEditing(true) }}>
        <Settings2 className="size-3.5"/>{t('strategyConfigure')}
      </Button>
      <Button size="sm" disabled={!strategy || config.isError}
        onClick={openTrigger}>{t(strategy?.kind === 'tag-push' ? 'strategyPushAction'
        : strategy?.kind === 'dispatch' ? 'strategyDispatchAction' : 'releaseCreateDraft')}</Button>
    </div>
    {strategy?.kind !== 'api' && <p className="text-xs text-[var(--muted)]">{t('strategyWorkflowWarning')}</p>}
    <Dialog open={editing} onOpenChange={next => { if (!next && !save.isPending) setEditing(false) }}>
      <DialogContent className="max-h-[88vh] overflow-y-auto">
        <DialogTitle>{t('strategyConfigure')}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
          {t('strategyConfigureHint')}
        </DialogDescription>
        <label className="mt-4 block text-xs" htmlFor="strategy-mode">{t('strategyMode')}</label>
        <select id="strategy-mode" value={mode} disabled={save.isPending}
          onChange={event => {
            setMode(event.target.value as ReleaseStrategy['kind'])
            setWorkflowId(0)
          }} className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-sm">
          <option value="api">{t('strategyApi')}</option>
          <option value="tag-push">{t('strategyTagPush')}</option>
          <option value="dispatch">{t('strategyDispatch')}</option>
        </select>
        {mode !== 'api' && <>
          <label className="mt-4 block text-xs" htmlFor="strategy-workflow">{t('strategyWorkflow')}</label>
          {workflows.isError && <p role="alert" className="mt-1 text-xs text-red-400">{t('strategyDiscoveryFailed')}</p>}
          <div className="mt-1 flex gap-2">
            <select id="strategy-workflow" value={workflowId} disabled={save.isPending || workflows.isPending}
              onChange={event => setWorkflowId(Number(event.target.value))}
              className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 text-sm">
              <option value={0}>{workflows.isPending ? t('strategyLoading') : t('strategyChooseWorkflow')}</option>
              {active.map(choice => <option key={choice.id} value={choice.id}>
                {choice.name} ({choice.path})
              </option>)}
            </select>
            <Button variant="secondary" size="icon" title={t('refresh')}
              disabled={workflows.isFetching} onClick={() => void workflows.refetch()}>
              <RefreshCw className="size-4"/>
            </Button>
          </div>
          {workflows.data?.truncated && <p className="mt-1 text-xs text-amber-400">{t('strategyDiscoveryTruncated')}</p>}
          {active.length === 0 && !workflows.isPending && !workflows.isError &&
            <p className="mt-1 text-xs text-[var(--muted)]">{t('strategyNone')}</p>}
          {mode === 'dispatch' && <>
            <label className="mt-4 block text-xs" htmlFor="strategy-ref">{t('strategyDispatchRef')}</label>
            <input id="strategy-ref" value={ref} maxLength={100}
              onChange={event => setRef(event.target.value)}
              className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"/>
          </>}
        </>}
        {failure && <p role="alert" className="mt-3 text-xs text-red-400">{failure}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" disabled={save.isPending} onClick={() => setEditing(false)}>{t('cancel')}</Button>
          <Button disabled={!ready || save.isPending} onClick={() => save.mutate()}>{t('strategySave')}</Button>
        </div>
      </DialogContent>
    </Dialog>
    <Dialog open={trigger} onOpenChange={next => { if (!next) closeTrigger() }}>
      <DialogContent className="max-h-[88vh] overflow-y-auto">
        <DialogTitle>{t(strategy?.kind === 'tag-push' ? 'strategyPushAction' : 'strategyDispatchAction')}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
          {t(strategy?.kind === 'tag-push' ? 'strategyTagPushWarning' : 'strategyDispatchWarning')}
        </DialogDescription>
        <p className="mt-3 text-xs text-[var(--muted)]">{repo} · {activeName}</p>
        {strategy?.kind === 'dispatch' && <p className="break-all font-mono text-xs">
          {t('strategyDispatchRef')}: {strategy.ref}
        </p>}
        <label htmlFor="strategy-tag" className="mt-4 block text-xs">{t('strategyTag')}</label>
        <div className="mt-1 flex gap-2">
          <input id="strategy-tag" value={tagName} maxLength={100}
            disabled={submitting || inspecting}
            onChange={e => { setTagName(e.target.value); setConfirmedTag(null) }}
            className="min-w-0 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2 text-sm"/>
          <Button variant="secondary" disabled={!tagName || submitting || inspecting}
            onClick={() => void previewTag()}>{t('releaseVerifyTag')}</Button>
        </div>
        {confirmedTag?.mode === 'tag-push' && <p className="mt-3 break-all font-mono text-xs">
          {t('tagsLocalObject')}: {confirmedTag.entry.local?.oid}
        </p>}
        {confirmedTag?.mode === 'dispatch' && <div className="mt-3 space-y-1 break-all font-mono text-xs">
          <p>{t('releaseTagObject')}: {confirmedTag.preview.tagOid}</p>
          <p>{t('releaseCommit')}: {confirmedTag.preview.commitSha}</p>
        </div>}
        {strategy?.kind === 'dispatch' && <>
          <label htmlFor="strategy-inputs" className="mt-4 block text-xs">{t('strategyInputs')}</label>
          <textarea id="strategy-inputs" rows={4} value={inputsText}
            disabled={submitting} onChange={e => setInputsText(e.target.value)}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2 font-mono text-xs"/>
          <p className="mt-1 text-xs text-[var(--muted)]">{t('strategyInputsHint')}</p>
        </>}
        {failure && <p role="alert" className="mt-3 text-xs text-red-400">{failure}</p>}
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="secondary" disabled={submitting || inspecting} onClick={closeTrigger}>{t('cancel')}</Button>
          <Button disabled={!confirmed || submitting || inspecting} onClick={() => void execute()}>
            {t('releaseConfirm')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  </section>
}
