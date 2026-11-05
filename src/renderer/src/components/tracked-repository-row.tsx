import { Link } from '@tanstack/react-router'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { GitBranch, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'

export function TrackedRepositoryRow({ fullName }: { fullName: string }) {
  const [owner, name] = fullName.split('/')
  const { t } = useTranslation()
  const cache = useQueryClient()
  const untrack = useMutation({
    mutationFn: () => window.spindle.trackRepository(owner, name, false),
    onSuccess: (workspace) => cache.setQueryData(['workspace'], workspace)
  })
  return <div className="flex items-center gap-2 border-b border-[var(--border)] px-3 last:border-b-0 hover:bg-[var(--hover)]">
    <Link to="/repo/$owner/$name" params={{ owner, name }}
      className="group flex min-w-0 flex-1 items-center gap-3 py-3.5 text-[var(--fg)] no-underline">
      <GitBranch className="size-4 shrink-0 text-orange-500"/>
      <div className="min-w-0 flex-1">
        <div className="truncate text-sm font-medium group-hover:text-orange-400">{name}</div>
        <div className="mt-0.5 truncate text-xs text-[var(--muted)]">{owner}</div>
      </div>
    </Link>
    <Button variant="ghost" size="icon" disabled={untrack.isPending}
      title={t('untrack')} aria-label={t('untrack')}
      onClick={() => untrack.mutate()}>
      <Star className="size-4 fill-orange-500 text-orange-500"/>
    </Button>
    {untrack.isError && <span role="alert" className="text-xs text-red-400">{t('untrackFailed')}</span>}
  </div>
}
