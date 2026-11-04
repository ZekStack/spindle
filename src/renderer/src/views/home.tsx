import { Link } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { ArrowUpRight, Building2, Github, Layers3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { AddOrganization } from '../components/add-organization'
import { Busy, ErrorState } from '../components/common'
import { Chip } from '../components/common'

export function HomePage() {
  const { t } = useTranslation()
  const workspace = useQuery({ queryKey: ['workspace'], queryFn: () => window.spindle.getWorkspace() })
  return <div className="space-y-9">
    <section className="relative overflow-hidden rounded-3xl border border-orange-500/20 bg-[#171716] p-8 text-white shadow-lg md:p-12">
      <div className="pointer-events-none absolute -right-24 -top-36 size-[440px] rounded-full bg-orange-500/14 blur-[85px]" />
      <div className="relative max-w-2xl">
        <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-orange-400/25 bg-orange-500/10 px-3 py-1 text-xs font-medium text-orange-300">
          <Github className="size-3.5"/> GitHub Desktop Workspace
        </div>
        <h1 className="text-3xl font-bold tracking-tight md:text-5xl">{t('welcome')}</h1>
        <p className="mt-5 max-w-xl text-base leading-relaxed text-neutral-400">{t('welcomeDetails')}</p>
        <div className="mt-8"><AddOrganization/></div>
      </div>
    </section>
    <section>
      <div className="mb-5 flex items-center justify-between">
        <div>
          <h2 className="text-xl font-semibold">{t('yourOrganizations')}</h2>
          <p className="mt-1 text-sm text-[var(--muted)]">{t('organizations')}</p>
        </div>
        {workspace.data && <Chip tone="orange">{workspace.data.organizations.length}</Chip>}
      </div>
      {workspace.isPending ? <Busy/> : workspace.isError ? <ErrorState error={workspace.error} retry={() => { void workspace.refetch() }}/> :
        workspace.data.organizations.length ? <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
          {workspace.data.organizations.map((login) => <Link key={login} to="/org/$login" params={{ login }}
            className="panel group flex min-h-36 items-center justify-between gap-4 p-6 no-underline transition hover:border-orange-500/35 hover:bg-[var(--surface-2)]">
            <div className="flex items-center gap-4">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-xl bg-orange-500/10 text-orange-500"><Building2 className="size-6"/></div>
              <div className="min-w-0">
                <div className="truncate font-semibold text-[var(--fg)]">{login}</div>
                <p className="mt-1 text-xs text-[var(--muted)]">{t('repositories')}</p>
              </div>
            </div>
            <ArrowUpRight className="size-5 shrink-0 text-[var(--muted)] transition group-hover:text-orange-400"/>
          </Link>)}
        </div> : <div className="panel flex flex-col items-center p-12 text-center">
          <Layers3 className="mb-4 size-8 text-orange-500/80"/>
          <h3 className="font-medium">{t('noOrganizations')}</h3>
          <p className="mt-2 text-sm text-[var(--muted)]">{t('noOrganizationsDetails')}</p>
        </div>}
    </section>
  </div>
}
