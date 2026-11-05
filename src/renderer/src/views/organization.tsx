import { useState, type FormEvent } from 'react'
import { Link } from '@tanstack/react-router'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { Building2, ChevronLeft, ChevronRight, GitBranch, LockKeyhole, Search, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { organizationRoute } from '../router'
import { Button } from '../components/ui/button'
import { Busy, Chip, ErrorState, ExternalGitHub } from '../components/common'
import { RemoveOrganization } from '../components/remove-organization'
import { readableDate, localizedGitHubError } from '../lib/utils'
import type { Repository } from '../../../shared/contracts'

function RepositoryRow({ repo, tracked }: { repo: Repository; tracked: boolean }) {
  const { t, i18n } = useTranslation()
  const cache = useQueryClient()
  const [pending, setPending] = useState(false)
  const mutation = useMutation({
    mutationFn: () => window.spindle.trackRepository(repo.fullName.split('/')[0], repo.name, !tracked),
    onMutate: () => setPending(true),
    onSettled: () => setPending(false),
    onSuccess: async () => { await cache.invalidateQueries({ queryKey: ['workspace'] }) }
  })
  const [owner, name] = repo.fullName.split('/')
  return <div className="flex items-center gap-3 border-b border-[var(--border)] px-4 py-3 last:border-0 hover:bg-[var(--hover)]/60">
    <Button variant="ghost" size="icon" disabled={pending} title={tracked ? t('untrack') : t('track')}
      aria-label={tracked ? t('untrack') : t('track')} onClick={() => mutation.mutate()}>
      <Star className={`size-4 ${tracked ? 'fill-orange-500 text-orange-500' : 'text-[var(--muted)]'}`} />
    </Button>
    <div className="min-w-0 flex-1">
      <Link to="/repo/$owner/$name" params={{ owner, name }}
        className="flex items-center gap-2 truncate font-medium text-[var(--fg)] no-underline hover:text-orange-400">
        <GitBranch className="size-3.5 shrink-0"/><span className="truncate">{repo.name}</span>
        {repo.private && <LockKeyhole className="size-3.5 shrink-0 text-[var(--muted)]"/>}
      </Link>
      <p className="mt-1 truncate text-xs text-[var(--muted)]">{repo.description || repo.fullName}</p>
      {mutation.isError && <p role="alert" className="mt-1 text-xs text-red-400">{localizedGitHubError(mutation.error, t)}</p>}
    </div>
    {repo.archived && <Chip>{t('archived')}</Chip>}
    <span className="hidden w-28 text-right text-xs text-[var(--muted)] md:block">{readableDate(repo.updatedAt, i18n.language)}</span>
    <ExternalGitHub url={repo.htmlUrl}/>
  </div>
}
export function OrganizationPage() {
  const { login } = organizationRoute.useParams()
  const { t } = useTranslation()
  const [page, setPage] = useState(1)
  const [filter, setFilter] = useState('')
  const [search, setSearch] = useState('')
  const workspace = useQuery({ queryKey: ['workspace'], queryFn: () => window.spindle.getWorkspace() })
  const organization = useQuery({ queryKey: ['org', login], queryFn: () => window.spindle.getOrganization(login) })
  const repos = useQuery({
    queryKey: ['repos', login, search, page],
    queryFn: () => search
      ? window.spindle.searchOrganizationRepositories(login, search, page)
      : window.spindle.listRepositories(login, page)
  })
  const tracked = workspace.data?.trackedRepositories ?? []
  const results = repos.data?.items ?? []
  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    setPage(1)
    setSearch(filter.trim())
  }
  return <div className="space-y-6">
    <div className="flex flex-col justify-between gap-5 sm:flex-row sm:items-start">
      <div className="flex items-center gap-4">
        <div className="flex size-14 items-center justify-center rounded-2xl bg-orange-500/10 text-orange-500"><Building2 className="size-7"/></div>
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{organization.data?.name || login}</h1>
          <p className="mt-1 text-sm text-[var(--muted)]">{login} · {t('organizations')}</p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {organization.data && <ExternalGitHub url={organization.data.htmlUrl}/>}
        <Button variant="secondary" size="sm" onClick={() => void repos.refetch()}>{t('refresh')}</Button>
        <RemoveOrganization login={login}/>
      </div>
    </div>
    {organization.isError && <ErrorState error={organization.error} retry={() => { void organization.refetch() }}/>}
    <div className="panel overflow-hidden">
      <div className="flex flex-col justify-between gap-4 border-b border-[var(--border)] p-5 sm:flex-row sm:items-center">
        <div><h2 className="text-lg font-semibold">{t('allRepositories')}</h2>
          <p className="mt-1 text-xs text-[var(--muted)]">{t('track')} · {tracked.filter((name) => name.split('/')[0].toLowerCase() === login.toLowerCase()).length} {t('tracked')}</p>
        </div>
        <form onSubmit={submitSearch} className="flex flex-wrap items-center gap-2">
          <label className="relative block min-w-0 flex-1 sm:w-72">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]"/>
            <input className="field w-full pl-9 text-sm" value={filter}
              aria-label={t('searchOrganizationRepositories')}
              placeholder={t('searchOrganizationRepositories')}
              onChange={(event) => setFilter(event.target.value)}/>
          </label>
          <Button variant="secondary" size="sm" type="submit"
            disabled={Boolean(filter.trim()) && filter.trim().length < 2}>{t('findRepository')}</Button>
          {search && <Button variant="ghost" size="sm" type="button"
            onClick={() => { setFilter(''); setSearch(''); setPage(1) }}>{t('clearSearch')}</Button>}
        </form>
      </div>
      {repos.isPending ? <div className="px-6"><Busy/></div> : repos.isError ? <div className="p-5"><ErrorState error={repos.error} retry={() => { void repos.refetch() }}/></div> :
        results.length ? results.map((repo) => <RepositoryRow key={repo.id} repo={repo} tracked={tracked.some((name) => name.toLowerCase() === repo.fullName.toLowerCase())}/>) :
          <p className="p-12 text-center text-sm text-[var(--muted)]">{t('noRepos')}</p>}
      <div className="flex items-center justify-between border-t border-[var(--border)] px-5 py-3">
        <Button variant="ghost" size="sm" disabled={page <= 1} onClick={() => setPage((value) => Math.max(1, value - 1))}>
          <ChevronLeft className="size-4"/>{t('previous')}
        </Button>
        <span className="text-xs text-[var(--muted)]">
          {t('pageNumber', { page })}{search && repos.data?.totalCount !== undefined
            ? ` · ${t('searchTotalResults', { count: repos.data.totalCount })}` : ''}
        </span>
        <Button variant="ghost" size="sm" disabled={!repos.data?.hasNext} onClick={() => setPage((value) => value + 1)}>
          {t('showMore')}<ChevronRight className="size-4"/>
        </Button>
      </div>
    </div>
    {workspace.isError && <ErrorState error={workspace.error} retry={() => { void workspace.refetch() }}/>}
  </div>
}
