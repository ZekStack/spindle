import { useState } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { CircleUserRound, ExternalLink, LoaderCircle, RefreshCw, ShieldAlert } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import type { GitHubIdentity } from '../../../shared/contracts'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

function methodLabel(method: GitHubIdentity['method'], t: (key: string) => string): string {
  return method === 'github-cli' ? t('identityCli')
    : method === 'environment' ? t('identityEnvironment')
      : t('identityNoCredentials')
}

export function AccountIdentity() {
  const { t } = useTranslation()
  const [open, setOpen] = useState(false)
  const cache = useQueryClient()
  const identity = useQuery({
    queryKey: ['github-identity'],
    queryFn: () => window.spindle.getGitHubIdentity(),
    staleTime: 60_000
  })
  const refresh = useMutation({
    mutationFn: () => window.spindle.getGitHubIdentity(true),
    onSuccess: (current) => {
      cache.setQueryData(['github-identity'], current)
      // Repository permissions may have changed with the GitHub account.
      void cache.invalidateQueries({ queryKey: ['workspace'] })
    }
  })
  const current = identity.data
  const viewer = current?.state === 'authenticated' ? current.account : null
  const unavailable = !current || current.state === 'unavailable'
  const problem = identity.isError || (current && !['authenticated', 'anonymous'].includes(current.state))
  const status = current?.state ?? 'unavailable'
  const title = viewer?.login ?? t('identityTitle')

  return <Dialog open={open} onOpenChange={setOpen}>
    <Button variant="ghost" className="max-w-44 gap-2" title={t('identityTitle')}
      aria-label={t('identityTitle')} onClick={() => setOpen(true)}>
      {viewer?.avatarUrl
        ? <img src={viewer.avatarUrl} alt="" className="size-7 rounded-full" />
        : <CircleUserRound className="size-5 shrink-0" />}
      <span className="hidden truncate text-xs md:inline">{viewer?.login ?? t('identityAccount')}</span>
      <span className={`size-1.5 shrink-0 rounded-full ${problem ? 'bg-red-500' :
        status === 'authenticated' ? 'bg-emerald-500' :
          unavailable ? 'bg-neutral-500' : 'bg-amber-500'}`}/>
    </Button>
    <DialogContent>
      <DialogTitle className="text-xl font-semibold">{t('identityTitle')}</DialogTitle>
      <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
        {t('identityDescription')}
      </DialogDescription>
      <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--surface-2)] p-4">
        {viewer ? <div className="flex items-center gap-3">
          {viewer.avatarUrl
            ? <img src={viewer.avatarUrl} alt="" className="size-12 rounded-full" />
            : <CircleUserRound className="size-10 text-orange-500" />}
          <div className="min-w-0">
            <div className="truncate font-semibold">{viewer.name || viewer.login}</div>
            <div className="text-sm text-[var(--muted)]">@{viewer.login}</div>
          </div>
        </div> : <div className="flex items-center gap-2 text-sm">
          {problem ? <ShieldAlert className="size-5 shrink-0 text-red-400"/>
            : <CircleUserRound className="size-5 shrink-0 text-orange-500"/>}
          {identity.isPending ? t('loading') : t(
            status === 'anonymous' ? 'identityAnonymous'
              : status === 'invalid' ? 'identityInvalid'
                : status === 'rate-limited' ? 'identityRateLimited'
                  : status === 'forbidden' ? 'identityForbidden'
                    : 'identityUnavailable'
          )}
        </div>}
        <div className="mt-4 text-xs text-[var(--muted)]">
          {t('identityCredentialSource')}: <span className="text-[var(--fg)]">
            {methodLabel(current?.method ?? 'anonymous', t)}
          </span>
        </div>
      </div>
      {viewer ? <>
        <div className="mt-5">
          <div className="text-sm font-medium">{t('identityScopes')}</div>
          {current?.scopes && current.scopes.length ? <div className="mt-2 flex flex-wrap gap-2">
            {current.scopes.map((scope) => <span key={scope}
              className="rounded-md border border-[var(--border)] bg-[var(--surface-2)] px-2 py-1 font-mono text-xs">
              {scope}
            </span>)}
          </div> : <p className="mt-2 text-xs text-[var(--muted)]">{t('identityScopesUnknown')}</p>}
          <p className="mt-2 text-xs leading-relaxed text-[var(--muted)]">{t('identityScopesNote')}</p>
        </div>
      </> : <p className="mt-4 text-sm leading-relaxed text-[var(--muted)]">
        {t('identitySignInHelp')}
        <code className="mt-2 block rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-3 font-mono text-sm text-[var(--fg)]">
          gh auth login
        </code>
      </p>}
      <p className="mt-4 text-xs leading-relaxed text-[var(--muted)]">{t('identitySignOutHelp')}</p>
      {refresh.isError && <p role="alert" className="mt-3 text-sm text-red-400">
        {t('identityRefreshError')}
      </p>}
      <div className="mt-6 flex flex-wrap justify-end gap-2">
        {viewer && <Button variant="secondary" onClick={() => {
          void window.spindle.openGitHub(viewer.htmlUrl)
        }}>
          <ExternalLink className="size-4"/>{t('identityViewProfile')}
        </Button>}
        <Button disabled={refresh.isPending} onClick={() => refresh.mutate()}>
          {refresh.isPending
            ? <LoaderCircle className="size-4 animate-spin"/>
            : <RefreshCw className="size-4"/>}
          {t('identityRefresh')}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
}
