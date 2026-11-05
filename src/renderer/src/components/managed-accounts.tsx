import { useState } from 'react'
import { useMutation, useQuery } from '@tanstack/react-query'
import { Check, CircleUserRound, LoaderCircle, Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'

/** Account selection affects future GitHub API calls, not local workspace data. */
export function ManagedAccounts({ onChanged }: { onChanged: () => Promise<void> }) {
  const { t } = useTranslation()
  const [confirmRemoval, setConfirmRemoval] = useState<string | null>(null)
  const accounts = useQuery({
    queryKey: ['github-managed-accounts'],
    queryFn: () => window.spindle.listManagedGitHubAccounts()
  })
  const select = useMutation({
    mutationFn: async (login: string | null) => {
      await window.spindle.selectManagedGitHubAccount(login)
      await onChanged()
    },
    onSuccess: () => {
      setConfirmRemoval(null)
      void accounts.refetch()
    }
  })
  const remove = useMutation({
    mutationFn: async (login: string) => {
      await window.spindle.removeManagedGitHubAccount(login)
      await onChanged()
    },
    onSuccess: () => {
      setConfirmRemoval(null)
      void accounts.refetch()
    }
  })
  const data = accounts.data
  const busy = select.isPending || remove.isPending

  return <section className="mt-5 border-t border-[var(--border)] pt-4">
    <div className="mb-2 flex items-center justify-between gap-3">
      <h3 className="text-sm font-semibold">{t('savedAccounts')}</h3>
      {data && <span className="text-xs text-[var(--muted)]">{data.logins.length}</span>}
    </div>
    <p className="mb-3 text-xs leading-relaxed text-[var(--muted)]">{t('savedAccountsHint')}</p>
    {accounts.isPending && <p className="text-xs text-[var(--muted)]">{t('loading')}</p>}
    {accounts.isError && <p role="alert" className="text-xs text-red-400">{t('accountListError')}</p>}
    {data && <div className="overflow-hidden rounded-xl border border-[var(--border)]">
      {data.logins.map((login) => {
        const active = data.activeLogin?.toLowerCase() === login.toLowerCase()
        return <div key={login.toLowerCase()} className="border-b border-[var(--border)] last:border-0">
          <div className="flex items-center gap-2 px-3 py-2">
            <button type="button" disabled={busy} onClick={() => select.mutate(login)}
              aria-label={t('selectAccount', { login })}
              className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-lg p-1 text-left hover:bg-[var(--hover)] disabled:opacity-50">
              <CircleUserRound className="size-5 shrink-0 text-orange-500"/>
              <span className="min-w-0 flex-1 truncate text-sm">{login}</span>
              {active && <span className="flex shrink-0 items-center gap-1 text-xs text-orange-400">
                <Check className="size-3.5"/>{t('accountActive')}
              </span>}
            </button>
            <Button variant="ghost" size="icon" disabled={busy}
              title={t('removeAccount', { login })} aria-label={t('removeAccount', { login })}
              onClick={() => setConfirmRemoval(confirmRemoval === login ? null : login)}>
              <Trash2 className="size-4 text-[var(--muted)]"/>
            </Button>
          </div>
          {confirmRemoval === login && <div className="flex flex-wrap items-center justify-between gap-2 bg-[var(--surface-2)] px-3 py-3">
            <span className="text-xs text-[var(--muted)]">{t('removeAccountWarning', { login })}</span>
            <div className="flex gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemoval(null)}>{t('cancel')}</Button>
              <Button variant="secondary" size="sm" disabled={busy} onClick={() => remove.mutate(login)}>
                {t('remove')}
              </Button>
            </div>
          </div>}
        </div>
      })}
      <button type="button" disabled={busy || data.legacyActive} onClick={() => select.mutate(null)}
        className="flex w-full cursor-pointer items-center gap-2 px-4 py-3 text-left text-sm hover:bg-[var(--hover)] disabled:opacity-50">
        <CircleUserRound className="size-5 shrink-0 text-[var(--muted)]"/>
        <span className="flex-1">{t('externalAccount')}</span>
        {data.activeLogin === null && !data.legacyActive &&
          <span className="flex items-center gap-1 text-xs text-orange-400"><Check className="size-3.5"/>{t('accountActive')}</span>}
      </button>
    </div>}
    {(select.isError || remove.isError) && <p role="alert" className="mt-2 text-xs text-red-400">
      {t('accountActionError')}
    </p>}
    {busy && <span className="mt-2 inline-flex items-center gap-2 text-xs text-[var(--muted)]">
      <LoaderCircle className="size-3.5 animate-spin"/>{t('loading')}
    </span>}
  </section>
}
