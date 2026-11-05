import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { GitBranch, LockKeyhole, Plus, Search, Star } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { Repository } from '../../../shared/contracts'
import { parseRepositoryFullName } from '../../../shared/contracts'
import { Button } from './ui/button'
import { Chip, ErrorState } from './common'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { localizedGitHubError } from '../lib/utils'

export function AddRepository({ compact = false }: { compact?: boolean }) {
  const { t } = useTranslation()
  const cache = useQueryClient()
  const [open, setOpen] = useState(false)
  const [input, setInput] = useState('')
  const [query, setQuery] = useState('')
  const [page, setPage] = useState(1)
  const [invalidPath, setInvalidPath] = useState(false)
  const search = useQuery({
    queryKey: ['repository-search', query, page],
    queryFn: () => window.spindle.searchRepositories(query, page),
    enabled: open && query.length > 0,
    staleTime: 30_000
  })
  const workspace = useQuery({
    queryKey: ['workspace'], queryFn: () => window.spindle.getWorkspace()
  })
  const mutation = useMutation({
    mutationFn: ({ owner, name }: { owner: string; name: string }) =>
      window.spindle.trackRepository(owner, name, true),
    onSuccess: (state) => cache.setQueryData(['workspace'], state)
  })
  const tracked = new Set((workspace.data?.trackedRepositories ?? []).map((name) => name.toLowerCase()))

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const value = input.trim()
    if (!value) return
    setInvalidPath(false)
    if (value.includes('/')) {
      try {
        const parts = parseRepositoryFullName(value)
        mutation.mutate(parts)
      } catch {
        setInvalidPath(true)
      }
      return
    }
    if (value.length < 2) return
    mutation.reset()
    setPage(1)
    setQuery(value)
  }

  function track(repository: Repository) {
    const [owner, name] = repository.fullName.split('/')
    mutation.mutate({ owner, name })
  }

  return <Dialog open={open} onOpenChange={(next) => {
    setOpen(next)
    if (next) {
      void workspace.refetch()
      mutation.reset()
    }
  }}>
    <Button variant={compact ? 'secondary' : 'default'} size={compact ? 'sm' : 'default'}
      onClick={() => setOpen(true)}>
      <Plus className="size-4"/>{t('addRepository')}
    </Button>
    <DialogContent className="max-h-[88vh] w-[min(94vw,650px)] overflow-y-auto">
      <DialogTitle className="text-xl font-semibold">{t('addRepository')}</DialogTitle>
      <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
        {t('addRepositoryDetails')}
      </DialogDescription>
      <form onSubmit={submit} className="mt-5 flex flex-col gap-2 sm:flex-row">
        <label className="relative min-w-0 flex-1">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-[var(--muted)]"/>
          <input autoFocus value={input} onChange={(e) => {
            setInput(e.target.value)
            setInvalidPath(false)
          }}
            maxLength={100} placeholder={t('repositorySearchPlaceholder')}
            aria-label={t('repositorySearchPlaceholder')}
            className="field h-10 w-full pl-9 text-sm"/>
        </label>
        <Button type="submit" disabled={mutation.isPending || input.trim().length < 2}>
          <Search className="size-4"/>{t('findRepository')}
        </Button>
      </form>
      <p className="mt-2 text-xs text-[var(--muted)]">{t('repositorySearchHint')}</p>
      {invalidPath && <p role="alert" className="mt-3 text-sm text-red-400">{t('repositoryInvalidPath')}</p>}
      {mutation.isError && <p role="alert" className="mt-3 text-sm text-red-400">{localizedGitHubError(mutation.error, t)}</p>}
      {mutation.isSuccess && <p role="status" className="mt-3 text-sm text-emerald-400">
        {t('repositoryAdded')}
      </p>}
      {query && <div className="mt-4 border-t border-[var(--border)] pt-4">
        <h3 className="mb-3 text-sm font-semibold">{t('repositorySearchResults')}</h3>
        {search.isPending && <p className="py-5 text-sm text-[var(--muted)]">{t('loading')}</p>}
        {search.isError && <ErrorState error={search.error} retry={() => { void search.refetch() }}/>}
        {search.data?.items.length === 0 && <p className="py-6 text-sm text-[var(--muted)]">{t('noRepos')}</p>}
        <div className="divide-y divide-[var(--border)] rounded-xl border border-[var(--border)]">
          {search.data?.items.map((repository) => {
            const added = tracked.has(repository.fullName.toLowerCase())
            return <div key={repository.id} className="flex items-center gap-3 px-3 py-3">
              <GitBranch className="size-4 shrink-0 text-orange-500"/>
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="truncate text-sm font-medium">{repository.fullName}</span>
                  {repository.private && <LockKeyhole aria-label={t('private')} className="size-3.5 text-[var(--muted)]"/>}
                  {repository.archived && <Chip>{t('archived')}</Chip>}
                </div>
                {repository.description && <p className="mt-1 truncate text-xs text-[var(--muted)]">{repository.description}</p>}
              </div>
              <Button variant="secondary" size="sm" disabled={added || mutation.isPending}
                onClick={() => track(repository)}>
                <Star className="size-3.5"/>{added ? t('tracked') : t('track')}
              </Button>
            </div>
          })}
        </div>
        {search.data && <div className="mt-3 flex items-center justify-between gap-3">
          <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
            {t('previous')}
          </Button>
          <span className="text-xs text-[var(--muted)]">{t('pageNumber', { page })}
            {search.data.totalCount !== undefined &&
              <span> · {t('searchTotalResults', { count: search.data.totalCount })}</span>}
          </span>
          <Button size="sm" variant="ghost" disabled={!search.data.hasNext}
            onClick={() => setPage(p => p + 1)}>{t('showMore')}</Button>
        </div>}
      </div>}
    </DialogContent>
  </Dialog>
}
