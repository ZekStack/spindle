import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, GitCommitHorizontal, RefreshCw, Workflow } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Busy, Chip, ErrorState, ExternalGitHub } from './common'
import { Button } from './ui/button'
import { readableDate } from '../lib/utils'
import type { WorkflowRunsFilter, WorkflowRunSummary } from '../../../shared/workflow-discovery'
import { workflowActionAllowed, type WorkflowControlAction } from '../../../shared/workflow-controls'
import { WorkflowDispatchControl, WorkflowRunControlDialog } from './workflow-controls'

interface Props { owner: string; name: string }

/** Read-only workflow discovery. All remote pagination is explicit and bounded. */
export function WorkflowExplorer({ owner, name }: Props) {
  const { t, i18n } = useTranslation()
  const cache = useQueryClient()
  const [command, setCommand] = useState<{
    run: WorkflowRunSummary; action: Exclude<WorkflowControlAction, 'dispatch'>
  } | null>(null)
  const [page, setPage] = useState(1)
  const [search, setSearch] = useState('')
  const [onlyActive, setOnlyActive] = useState(false)
  const [selected, setSelected] = useState<number | null>(null)
  const [runPage, setRunPage] = useState(1)
  const [branch, setBranch] = useState('')
  const [event, setEvent] = useState('')
  const [status, setStatus] = useState('')
  const catalog = useQuery({
    queryKey: ['workflow-catalog', owner, name, page],
    queryFn: () => window.spindle.listWorkflowCatalog(owner, name, page),
    retry: false
  })
  const source = useQuery({
    queryKey: ['workflow-source', owner, name, selected],
    queryFn: () => window.spindle.getWorkflowSource(owner, name, selected!),
    enabled: selected !== null,
    staleTime: 60_000, retry: false
  })
  const identity = useQuery({
    queryKey: ['github-identity'],
    queryFn: () => window.spindle.getGitHubIdentity(),
    staleTime: 30_000, retry: false
  })
  const filter: WorkflowRunsFilter = {
    page: runPage,
    ...(branch.trim() ? { branch: branch.trim() } : {}),
    ...(event ? { event } : {}),
    ...(status ? { status } : {})
  }
  const runs = useQuery({
    queryKey: ['workflow-runs-page', owner, name, selected, runPage, branch.trim(), event, status],
    queryFn: () => window.spindle.listWorkflowRunPage(owner, name, selected!, filter),
    enabled: selected !== null, retry: false
  })

  useEffect(() => {
    setPage(1)
    setSelected(null)
    setRunPage(1)
    setSearch('')
    setBranch('')
    setEvent('')
    setStatus('')
    setCommand(null)
  }, [owner, name])

  function chooseWorkflow(id: number) {
    setCommand(null)
    setSelected(id)
    setRunPage(1)
    setBranch('')
    setEvent('')
    setStatus('')
  }
  function accepted() {
    void cache.invalidateQueries({ queryKey: ['workflow-runs-page', owner, name] })
    void cache.invalidateQueries({ queryKey: ['workflow-catalog', owner, name] })
    window.dispatchEvent(new Event('spindle:activity:open'))
  }
  function refresh() {
    void catalog.refetch()
    if (selected !== null) { void source.refetch(); void runs.refetch() }
    void identity.refetch()
  }
  const needle = search.trim().toLowerCase()
  const visible = catalog.data?.items.filter(w =>
    (!onlyActive || w.state === 'active') &&
    (!needle || w.name.toLowerCase().includes(needle) ||
      w.path.toLowerCase().includes(needle))) ?? []
  const current = source.data

  return <div className="space-y-4">
    <section className="panel space-y-3 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">{t('wfCatalogTitle')}</h2>
          <p className="text-xs text-[var(--muted)]">{t('wfCatalogHint')}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={refresh}>
          <RefreshCw className="size-3.5"/>{t('refresh')}
        </Button>
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <input aria-label={t('wfSearch')} value={search} maxLength={100}
          placeholder={t('wfSearch')} onChange={e => setSearch(e.target.value)}
          className="min-w-40 flex-1 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"/>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyActive} onChange={e => setOnlyActive(e.target.checked)}/>
          {t('wfActiveOnly')}
        </label>
      </div>
      <p className="text-xs text-[var(--muted)]">
        {t('wfPageHint', { page, count: catalog.data?.items.length ?? 0 })}
        {catalog.data?.totalCount !== undefined &&
          ` · ${t('searchTotalResults', { count: catalog.data.totalCount })}`}
      </p>
      {catalog.isPending ? <Busy/> : catalog.isError ?
        <ErrorState error={catalog.error} retry={() => void catalog.refetch()}/> :
        visible.length === 0 ? <p className="py-6 text-center text-sm text-[var(--muted)]">
          {t('wfNoneOnPage')}
        </p> :
        <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {visible.map(w => <button key={w.id} type="button" onClick={() => chooseWorkflow(w.id)}
            aria-pressed={selected === w.id}
            className={`flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left hover:bg-[var(--hover)] ${selected === w.id ? 'bg-[var(--surface-2)]' : ''}`}>
            <Workflow className="size-4 shrink-0 text-orange-400"/>
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold">{w.name}</span>
              <span className="block truncate font-mono text-xs text-[var(--muted)]">{w.path}</span>
            </span>
            <Chip tone={w.state === 'active' ? 'green' : undefined}>{w.state}</Chip>
          </button>)}
        </div>}
      <div className="flex items-center justify-between gap-2">
        <Button size="sm" variant="secondary" disabled={page === 1 || catalog.isFetching}
          onClick={() => setPage(p => Math.max(1, p - 1))}>{t('previous')}</Button>
        <span className="text-xs text-[var(--muted)]">{t('pageNumber', { page })}</span>
        <Button size="sm" variant="secondary" disabled={!catalog.data?.hasNext || catalog.isFetching}
          onClick={() => setPage(p => p + 1)}>{t('showMore')}</Button>
      </div>
    </section>
    {selected !== null && <section className="panel space-y-4 p-5">
      <h3 className="text-base font-semibold">{t('wfDefinitionTitle')}</h3>
      {source.isPending ? <Busy/> : source.isError ?
        <ErrorState error={source.error} retry={() => void source.refetch()}/> : current && <>
          <div className="space-y-1 text-xs">
            <p className="font-semibold">{current.workflow.name} · <span className="font-normal">{current.workflow.state}</span></p>
            <p className="break-all font-mono text-[var(--muted)]">{current.workflow.path}</p>
            <p><GitBranch className="mr-1 inline size-3"/>{t('wfSourceBranch')}: {current.branch}</p>
            {current.fileBlobSha && <p className="break-all font-mono">
              {t('wfSourceBlob')}: {current.fileBlobSha}</p>}
          </div>
          <p className="text-xs text-[var(--muted)]">{t('wfSourceSafety')}</p>
          {current.sourceState !== 'parsed' ?
            <p role="status" className="text-sm text-amber-400">
              {t(`wfSource_${current.sourceState}`)}
            </p> : <>
              <div>
                <h4 className="text-sm font-semibold">{t('wfTriggers')}</h4>
                {current.triggers.length === 0 ? <p className="mt-2 text-xs text-[var(--muted)]">
                  {t('wfNotDeclared')}
                </p> : <div className="mt-2 flex flex-wrap gap-2">
                  {current.triggers.map((trigger, index) =>
                    <div key={`${trigger.event}-${index}`}
                      className="min-w-0 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-xs">
                      <span className="font-semibold">{trigger.event}</span>
                      {trigger.filters.map((item, i) => <p key={i} className="mt-1 break-all text-[var(--muted)]">{item}</p>)}
                      {trigger.complex && <p className="mt-1 text-amber-400">{t('wfDynamic')}</p>}
                    </div>)}
                </div>}
              </div>
              <div>
                <h4 className="text-sm font-semibold">{t('wfDispatchInputs')}</h4>
                {current.triggers.some(v => v.event === 'workflow_dispatch') ? (
                  current.dispatchInputs.length > 0 ?
                    <div className="mt-2 divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
                      {current.dispatchInputs.map(input => <div key={input.name} className="px-3 py-2 text-xs">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="font-mono font-semibold">{input.name}</span>
                          <span className="text-[var(--muted)]">{input.type}</span>
                          {input.required && <Chip tone="orange">{t('wfRequired')}</Chip>}
                        </div>
                        {input.description && <p className="mt-1 text-[var(--muted)]">{input.description}</p>}
                        {input.options.length > 0 && <p className="mt-1 text-[var(--muted)]">
                          {t('wfOptions')}: {input.options.join(', ')}</p>}
                      </div>)}
                    </div> : <p className="mt-2 text-xs text-[var(--muted)]">{t('wfNoDispatchInputs')}</p>
                ) : <p className="mt-2 text-xs text-[var(--muted)]">{t('wfNoDispatchEvent')}</p>}
              </div>
              <WorkflowDispatchControl owner={owner} name={name} source={current}
                onAccepted={accepted}/>
              <div className="space-y-2">
                <h4 className="text-sm font-semibold">{t('wfPermissions')}</h4>
                <p className="text-xs text-[var(--muted)]">{t('wfPermissionsHint')}</p>
                <p className="text-xs">{t('wfTopLevel')}: {t(`wfPerm_${current.permissions.mode}`)}</p>
                {current.permissions.entries.map(p => <p key={p.scope} className="break-all font-mono text-xs">
                  {p.scope}: {p.access}</p>)}
                {current.jobPermissions.map(job => <div key={job.job}
                  className="rounded-lg border border-[var(--border)] px-3 py-2 text-xs">
                  <p className="font-mono font-semibold">{job.job} · {t(`wfPerm_${job.permissions.mode}`)}</p>
                  {job.permissions.entries.map(p => <p key={p.scope} className="break-all text-[var(--muted)]">
                    {p.scope}: {p.access}</p>)}
                </div>)}
                <p className="text-xs text-[var(--muted)]">
                  {t('wfAccountScopes')}: {identity.isPending ? t('loading') :
                    identity.data?.scopes?.join(', ') || t('wfScopesUnknown')}
                </p>
                <p className="text-xs text-[var(--muted)]">{t('wfScopesCaveat')}</p>
              </div>
            </>}
        </>}
    </section>}
    {selected !== null && <section className="panel space-y-4 p-5">
      <div>
        <h3 className="text-base font-semibold">{t('wfRunsTitle')}</h3>
        <p className="text-xs text-[var(--muted)]">{t('wfRunsHint')}</p>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        <div>
          <label htmlFor="wf-run-branch" className="text-xs">{t('wfBranchFilter')}</label>
          <input id="wf-run-branch" value={branch} maxLength={120}
            placeholder={t('wfAllBranches')}
            onChange={e => { setBranch(e.target.value); setRunPage(1) }}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"/>
        </div>
        <div>
          <label htmlFor="wf-run-event" className="text-xs">{t('event')}</label>
          <select id="wf-run-event" value={event} onChange={e => { setEvent(e.target.value); setRunPage(1) }}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 text-sm">
            <option value="">{t('wfAllEvents')}</option>
            {['push','pull_request','workflow_dispatch','schedule','release','workflow_run'].map(v =>
              <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
        <div>
          <label htmlFor="wf-run-status" className="text-xs">{t('status')}</label>
          <select id="wf-run-status" value={status} onChange={e => { setStatus(e.target.value); setRunPage(1) }}
            className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 text-sm">
            <option value="">{t('wfAllStatuses')}</option>
            {['queued', 'in_progress', 'completed', 'success', 'failure', 'cancelled', 'timed_out'].map(v =>
              <option key={v} value={v}>{v}</option>)}
          </select>
        </div>
      </div>
      {runs.isPending ? <Busy/> : runs.isError ?
        <ErrorState error={runs.error} retry={() => void runs.refetch()}/> :
        runs.data?.items.length === 0 ? <p className="py-6 text-center text-sm text-[var(--muted)]">
          {t('wfNoRuns')}
        </p> : <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
          {runs.data?.items.map(run => <div key={run.id} className="flex items-start gap-3 p-3">
            <GitCommitHorizontal className="mt-1 size-4 shrink-0 text-orange-400"/>
            <div className="min-w-0 flex-1 space-y-1 text-xs">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold">{run.name || current?.workflow.name}</span>
                <span>#{run.number} · {t('wfAttempt')} {run.attempt}</span>
                <Chip tone={run.conclusion === 'success' ? 'green' :
                  run.conclusion === 'failure' ? 'red' : 'orange'}>
                  {run.conclusion || run.status}</Chip>
              </div>
              <p className="break-all">{run.event} · {run.headBranch || t('wfNoBranch')}</p>
              <p className="break-all font-mono text-[var(--muted)]">{run.headSha}</p>
              <p className="text-[var(--muted)]">{readableDate(run.createdAt, i18n.language)}</p>
            </div>
            <div className="flex shrink-0 flex-col items-end gap-2">
              <ExternalGitHub url={run.htmlUrl}/>
              {identity.data?.state === 'authenticated' && <div className="flex flex-wrap justify-end gap-1">
                {(['cancel', 'rerun', 'rerun-failed'] as const).filter(action =>
                  workflowActionAllowed(action, run.status, run.conclusion)).map(action =>
                    <Button key={action} variant="secondary" size="sm"
                      onClick={() => setCommand({ run, action })}>
                      {t(action === 'cancel' ? 'wfControlCancel' :
                        action === 'rerun' ? 'wfControlRerun' : 'wfControlRerunFailed')}
                    </Button>)}
              </div>}
            </div>
          </div>)}
        </div>}
      <div className="flex items-center justify-between gap-2">
        <Button variant="secondary" size="sm" disabled={runPage === 1 || runs.isFetching}
          onClick={() => setRunPage(p => Math.max(1, p - 1))}>{t('previous')}</Button>
        <span className="text-xs text-[var(--muted)]">
          {t('pageNumber', { page: runPage })}
          {runs.data?.totalCount !== undefined &&
            ` · ${t('searchTotalResults', { count: runs.data.totalCount })}`}
        </span>
        <Button variant="secondary" size="sm" disabled={!runs.data?.hasNext || runs.isFetching}
          onClick={() => setRunPage(p => p + 1)}>{t('showMore')}</Button>
      </div>
    </section>}
    <WorkflowRunControlDialog owner={owner} name={name}
      run={command?.run ?? null} action={command?.action ?? null}
      onClose={() => setCommand(null)} onAccepted={accepted}/>
  </div>
}
