import { useMemo, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Building2, Search, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AddOrganization } from '../components/add-organization'
import { AddRepository } from '../components/add-repository'
import { TrackedRepositoryRow } from '../components/tracked-repository-row'
import { WorkspaceDirectories } from '../components/local-workspaces'
import { Busy, ErrorState } from '../components/common'

/** Local workspace first: no feed mocks, promotional panels or extra API calls. */
export function HomePage() {
  const { t } = useTranslation()
  const [search, setSearch] = useState('')
  const workspace = useQuery({
    queryKey: ['workspace'], queryFn: () => window.spindle.getWorkspace()
  })
  const tracked = workspace.data?.trackedRepositories ?? []
  const organizations = workspace.data?.organizations ?? []
  const term = search.trim().toLocaleLowerCase()
  const matchingTracked = useMemo(() => tracked.filter((name) =>
    name.toLocaleLowerCase().includes(term)), [tracked, term])
  const matchingOrganizations = useMemo(() => organizations.filter((login) =>
    login.toLocaleLowerCase().includes(term)), [organizations, term])
  const hasTracked = tracked.length > 0

  return <div className="space-y-6">
    <div className="flex flex-col gap-4 border-b border-[var(--border)] pb-5 lg:flex-row lg:items-end lg:justify-between">
      <div className="min-w-0">
        <h1 className="text-2xl font-semibold tracking-tight">{t('workspaceTitle')}</h1>
        <p className="mt-1 text-sm text-[var(--muted)]">{t('workspaceSummary')}</p>
        {workspace.data && <p className="mt-2 text-xs text-[var(--muted)]">
          {organizations.length} {t('organizations').toLocaleLowerCase()} · {tracked.length} {t('tracked').toLocaleLowerCase()}
        </p>}
      </div>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <label className="relative block w-full sm:w-80 xl:w-96">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]"/>
          <input value={search} onChange={(event) => setSearch(event.target.value)}
            placeholder={t('workspaceSearch')} aria-label={t('workspaceSearch')}
            className="field h-9 w-full pl-9 text-sm" />
        </label>
        <AddRepository compact/>
        <AddOrganization compact/>
      </div>
    </div>

    {workspace.isPending ? <Busy/> : workspace.isError
      ? <ErrorState error={workspace.error} retry={() => { void workspace.refetch() }}/>
      : <div className={hasTracked
        ? 'grid min-w-0 gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(320px,1fr)]'
        : 'space-y-5'}>
        {hasTracked && <section className="panel min-w-0 overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <div>
              <h2 className="font-semibold">{t('workspaceTracked')}</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">{t('workspaceTrackedHint')}</p>
            </div>
            <span className="text-xs text-[var(--muted)]">{tracked.length}</span>
          </div>
          {matchingTracked.length ? <div>
            {matchingTracked.map((fullName) =>
              <TrackedRepositoryRow key={fullName.toLocaleLowerCase()} fullName={fullName}/>
            )}
          </div> : <p className="px-5 py-8 text-sm text-[var(--muted)]">{t('workspaceNoMatches')}</p>}
        </section>}

        <section className="panel min-w-0 overflow-hidden">
          <div className="flex items-center justify-between border-b border-[var(--border)] px-5 py-4">
            <div>
              <h2 className="font-semibold">{t('workspaceOrganizations')}</h2>
              <p className="mt-1 text-xs text-[var(--muted)]">{t('workspaceOrganizationsHint')}</p>
            </div>
            <span className="text-xs text-[var(--muted)]">{organizations.length}</span>
          </div>
          {matchingOrganizations.length ? <div className={hasTracked
            ? '' : matchingOrganizations.length >= 3
              ? 'grid gap-0 md:grid-cols-2 2xl:grid-cols-3'
              : 'grid gap-0 md:grid-cols-2'}>
            {matchingOrganizations.map((login) => {
              const count = tracked.filter((name) =>
                name.split('/')[0].toLowerCase() === login.toLowerCase()).length
              return <Link key={login.toLowerCase()} to="/org/$login" params={{ login }}
                className="group flex min-w-0 items-center gap-3 border-b border-[var(--border)] px-5 py-4 text-[var(--fg)] no-underline transition-colors hover:bg-[var(--hover)]">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-2)] text-orange-500">
                  <Building2 className="size-4"/>
                </div>
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium group-hover:text-orange-400">{login}</div>
                  <p className="mt-0.5 text-xs text-[var(--muted)]">
                    {t('workspacePinnedCount', { count })}
                  </p>
                </div>
                <ArrowUpRight className="size-4 shrink-0 text-[var(--muted)]"/>
              </Link>
            })}
          </div> : <p className="px-5 py-8 text-sm text-[var(--muted)]">
            {organizations.length ? t('workspaceNoMatches') : t('noOrganizationsDetails')}
          </p>}
        </section>

        {!hasTracked && <section className="flex items-start gap-3 rounded-xl border border-dashed border-[var(--border)] px-5 py-4">
          <Star className="mt-0.5 size-4 shrink-0 text-orange-500"/>
          <div>
            <h2 className="text-sm font-medium">{t('workspaceNoTracked')}</h2>
            <p className="mt-1 text-xs text-[var(--muted)]">{t('workspaceNoTrackedHint')}</p>
          </div>
        </section>}
      </div>}
    <WorkspaceDirectories/>
  </div>
}
