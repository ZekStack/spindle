import { useState, type FormEvent } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Building2, Plus, Search } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { errorMessage } from '../lib/utils'

export function AddOrganization({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const [searchTerm, setSearchTerm] = useState('')
  const [page, setPage] = useState(1)
  const navigate = useNavigate()
  const cache = useQueryClient()
  const { t } = useTranslation()
  const suggestions = useQuery({
    queryKey: ['organization-search', searchTerm, page],
    queryFn: () => window.spindle.searchOrganizations(searchTerm, page),
    enabled: open && searchTerm.length >= 2,
    staleTime: 30_000
  })
  const mutation = useMutation({
    mutationFn: (login: string) => window.spindle.addOrganization(login),
    onSuccess: async (_data, login) => {
      await cache.invalidateQueries({ queryKey: ['workspace'] })
      setOpen(false)
      setValue('')
      await navigate({ to: '/org/$login', params: { login } })
    }
  })
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (value.trim()) mutation.mutate(value.trim())
  }
  return <Dialog open={open} onOpenChange={(next) => { setOpen(next); if (next) mutation.reset() }}>
    <Button size={compact ? 'sm' : 'default'} onClick={() => setOpen(true)}><Plus className="size-4"/>{t('addOrganization')}</Button>
    <DialogContent>
      <DialogTitle className="text-xl font-semibold">{t('addOrganization')}</DialogTitle>
      <DialogDescription className="mt-2 text-sm text-[var(--muted)]">{t('orgDialogDetails')}</DialogDescription>
      <form onSubmit={submit} className="mt-6 flex flex-col gap-4">
        <label className="flex flex-col gap-2 text-sm font-medium">
          {t('orgName')}
          <input value={value} onChange={(event) => setValue(event.target.value)}
            autoFocus required maxLength={39} placeholder={t('orgPlaceholder')}
            className="h-11 rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 outline-none focus:border-orange-500" />
        </label>
        {mutation.isError && <div role="alert" className="rounded-lg bg-red-500/10 p-3 text-xs text-red-400">
          <strong>{t('addOrganizationError')}:</strong> {errorMessage(mutation.error)}
        </div>}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={value.trim().length < 2}
            onClick={() => {
              setPage(1)
              setSearchTerm(value.trim())
            }}>
            <Search className="size-4"/>{t('searchOrganizations')}
          </Button>
          <Button variant="secondary" onClick={() => setOpen(false)}>{t('cancel')}</Button>
          <Button type="submit" disabled={!value.trim() || mutation.isPending}>{t('add')}</Button>
        </div>
        {searchTerm && <section className="border-t border-[var(--border)] pt-4">
          <h3 className="mb-2 text-sm font-semibold">{t('organizationSearchResults')}</h3>
          {suggestions.isPending && <p className="text-sm text-[var(--muted)]">{t('loading')}</p>}
          {suggestions.isError && <p role="alert" className="text-sm text-red-400">
            {t('organizationSearchError')}
          </p>}
          {suggestions.data?.length === 0 && <p className="text-sm text-[var(--muted)]">{t('noOrganizationsFound')}</p>}
          <div className="divide-y divide-[var(--border)] rounded-lg border border-[var(--border)]">
            {suggestions.data?.map((org) => <div key={org.login} className="flex items-center gap-2 px-3 py-2">
              <Building2 className="size-4 shrink-0 text-orange-500"/>
              <span className="min-w-0 flex-1 truncate text-sm">{org.login}</span>
              <Button size="sm" variant="secondary" disabled={mutation.isPending}
                onClick={() => mutation.mutate(org.login)}>{t('add')}</Button>
            </div>)}
          </div>
          {suggestions.data && <div className="mt-2 flex items-center justify-between">
            <Button size="sm" variant="ghost" disabled={page <= 1} onClick={() => setPage(p => p - 1)}>
              {t('previous')}
            </Button>
            <span className="text-xs text-[var(--muted)]">{page}</span>
            <Button size="sm" variant="ghost" disabled={suggestions.data.length < 20}
              onClick={() => setPage(p => p + 1)}>{t('showMore')}</Button>
          </div>}
        </section>}
      </form>
    </DialogContent>
  </Dialog>
}
