import { useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import { ChevronLeft, GitBranch, LockKeyhole, Tag, Workflow, GitCommitHorizontal, RefreshCw, Star, Activity } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { repositoryRoute } from '../router'
import { Button } from '../components/ui/button'
import { Busy, Chip, ErrorState, ExternalGitHub } from '../components/common'
import { readableDate } from '../lib/utils'

type Tab = 'overview' | 'releases' | 'workflows'
export function RepositoryPage() {
  const { owner, name } = repositoryRoute.useParams()
  const { t, i18n } = useTranslation()
  const [tab, setTab] = useState<Tab>('overview')
  const [inspectionError, setInspectionError] = useState(false)
  const [inspecting, setInspecting] = useState(false)
  async function inspectRepository() {
    setInspecting(true)
    setInspectionError(false)
    try {
      await window.spindle.inspectRepository(owner, name)
      window.dispatchEvent(new Event('spindle:activity:open'))
    } catch { setInspectionError(true) }
    finally { setInspecting(false) }
  }
  const cache = useQueryClient()
  const workspace = useQuery({ queryKey: ['workspace'], queryFn: () => window.spindle.getWorkspace() })
  const tracked = workspace.data?.trackedRepositories.some((entry) =>
    entry.toLowerCase() === `${owner}/${name}`.toLowerCase()) ?? false
  const savedOrganization = workspace.data?.organizations.some((org) =>
    org.toLowerCase() === owner.toLowerCase()) ?? false
  const trackMutation = useMutation({
    mutationFn: () => window.spindle.trackRepository(owner, name, !tracked),
    onSuccess: (updated) => cache.setQueryData(['workspace'], updated)
  })
  const repository = useQuery({ queryKey: ['repo', owner, name], queryFn: () => window.spindle.getRepository(owner, name) })
  const releases = useQuery({
    queryKey: ['releases', owner, name], queryFn: () => window.spindle.listReleases(owner, name),
    enabled: tab === 'releases', refetchInterval: tab === 'releases' ? 60_000 : false
  })
  const workflows = useQuery({
    queryKey: ['runs', owner, name], queryFn: () => window.spindle.listWorkflowRuns(owner, name),
    enabled: tab === 'workflows', refetchInterval: tab === 'workflows' ? 30_000 : false
  })
  const tabs: { key: Tab; label: string; icon: typeof GitBranch }[] = [
    { key: 'overview', label: t('overview'), icon: GitBranch },
    { key: 'releases', label: t('releases'), icon: Tag },
    { key: 'workflows', label: t('workflows'), icon: Workflow }
  ]
  return <div className="space-y-6">
    {savedOrganization
      ? <Link to="/org/$login" params={{ login: owner }}
        className="inline-flex items-center gap-2 text-sm text-[var(--muted)] no-underline hover:text-orange-400">
        <ChevronLeft className="size-4"/>{t('backToOrg')}
      </Link>
      : <Link to="/" className="inline-flex items-center gap-2 text-sm text-[var(--muted)] no-underline hover:text-orange-400">
        <ChevronLeft className="size-4"/>{t('backToWorkspace')}
      </Link>}
    <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-center">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-3xl font-bold tracking-tight">{name}</h1>
          {repository.data?.private && <LockKeyhole className="size-4 text-orange-400"/>}
        </div>
        <p className="mt-1 text-sm text-[var(--muted)]">{owner} / {name}</p>
      </div>
      <div className="flex flex-wrap gap-2">
        {trackMutation.isError && <span role="alert" className="self-center text-xs text-red-400">{t('repositoryTrackFailed')}</span>}
        <Button variant="secondary" size="sm"
          disabled={trackMutation.isPending || workspace.isPending}
          onClick={() => trackMutation.mutate()}>
          <Star className={`size-3.5 ${tracked ? 'fill-orange-500 text-orange-500' : ''}`}/>
          {tracked ? t('untrack') : t('track')}
        </Button>
        <Button variant="secondary" size="sm" disabled={inspecting}
          onClick={() => void inspectRepository()}>
          <Activity className="size-3.5"/>{t('activityInspect')}
        </Button>
        {inspectionError && <span role="alert" className="self-center text-xs text-red-400">
          {t('activityFailed')}
        </span>}
        {repository.data && <ExternalGitHub url={repository.data.htmlUrl}/>
        <Button variant="secondary" size="sm" onClick={() => {
          void repository.refetch()
          if (tab === 'releases') void releases.refetch()
          if (tab === 'workflows') void workflows.refetch()
        }}><RefreshCw className="size-3.5"/>{t('refresh')}</Button>
      </div>
    </div>
    {repository.isPending ? <Busy/> : repository.isError ? <ErrorState error={repository.error} retry={() => { void repository.refetch() }}/> :
      <p className="text-sm text-[var(--muted)]">{repository.data.description || repository.data.fullName}</p>}
    <div className="flex gap-1 rounded-xl border border-[var(--border)] bg-[var(--surface)] p-1.5">
      {tabs.map(({ key, label, icon: Icon }) => <button key={key} onClick={() => setTab(key)}
        className={`flex flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition ${tab === key ? 'bg-orange-500 text-neutral-950' : 'text-[var(--muted)] hover:bg-[var(--hover)]'}`}>
        <Icon className="size-4"/>{label}
      </button>)}
    </div>
    {tab === 'overview' && <div className="grid gap-4 sm:grid-cols-2">
      <div className="panel p-6">
        <div className="text-xs uppercase tracking-widest text-[var(--muted)]">{t('branch')}</div>
        <div className="mt-3 flex items-center gap-2 text-lg font-semibold"><GitBranch className="size-4 text-orange-400"/>{repository.data?.defaultBranch || '—'}</div>
      </div>
      <div className="panel p-6">
        <div className="text-xs uppercase tracking-widest text-[var(--muted)]">{t('updated')}</div>
        <div className="mt-3 flex items-center gap-2 text-lg font-semibold"><GitCommitHorizontal className="size-4 text-orange-400"/>{readableDate(repository.data?.updatedAt, i18n.language)}</div>
      </div>
      <div className="panel p-6 sm:col-span-2">
        <Chip tone="orange">{t('readOnly')}</Chip>
        <p className="mt-3 text-sm text-[var(--muted)]">{t('readOnlyDescription')}</p>
      </div>
    </div>}
    {tab === 'releases' && <div className="panel overflow-hidden">
      {releases.isPending ? <div className="p-6"><Busy/></div> : releases.isError ?
        <div className="p-5"><ErrorState error={releases.error} retry={() => void releases.refetch()}/></div> :
        !releases.data.length ? <p className="p-10 text-center text-sm muted">{t('noReleases')}</p> :
        releases.data.map((release) => <div key={release.id} className="flex items-center gap-4 border-b border-[var(--border)] px-5 py-4 last:border-0">
          <div className="flex size-10 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500"><Tag className="size-5"/></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{release.name || release.tagName}</span>
              {release.draft ? <Chip>{t('draft')}</Chip> :
               release.prerelease ? <Chip tone="orange">{t('prerelease')}</Chip> :
               <Chip tone="green">{t('published')}</Chip>}
            </div>
            <p className="mt-1 text-xs muted">{release.tagName} · {readableDate(release.publishedAt, i18n.language)}</p>
          </div>
          <ExternalGitHub url={release.htmlUrl}/>
        </div>)}
    </div>}
    {tab === 'workflows' && <div className="panel overflow-hidden">
      {workflows.isPending ? <div className="p-6"><Busy/></div> : workflows.isError ?
        <div className="p-5"><ErrorState error={workflows.error} retry={() => void workflows.refetch()}/></div> :
        !workflows.data.length ? <p className="p-10 text-center text-sm muted">{t('noWorkflows')}</p> :
        workflows.data.map((run) => <div key={run.id} className="flex items-center gap-4 border-b border-[var(--border)] px-5 py-4 last:border-0">
          <div className="flex size-10 items-center justify-center rounded-xl bg-[var(--surface-2)] text-orange-500"><Workflow className="size-5"/></div>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium">{run.name}</span>
              <Chip tone={run.conclusion === 'success' ? 'green' : run.conclusion === 'failure' ? 'red' : 'orange'}>
                {run.conclusion || run.status}
              </Chip>
            </div>
            <p className="mt-1 text-xs muted">{run.headBranch} · {run.event} · {readableDate(run.createdAt, i18n.language)}</p>
          </div>
          <ExternalGitHub url={run.htmlUrl}/>
        </div>)}
    </div>}
  </div>
}
