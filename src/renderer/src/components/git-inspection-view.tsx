import { useTranslation } from 'react-i18next'
import type { GitTagInventory, LocalGitInspection } from '../../../shared/git-inspection'

function Tags({ inventory, title }: { inventory: GitTagInventory; title: string }) {
  const { t } = useTranslation()
  return <div className="min-w-0 rounded-lg border border-[var(--border)] p-3">
    <div className="flex items-baseline justify-between gap-2 text-xs font-semibold">
      <span>{title}</span>
      <span className="tabular-nums text-[var(--muted)]">{inventory.total}</span>
    </div>
    {inventory.names.length
      ? <div className="mt-2 flex max-h-32 flex-wrap gap-1.5 overflow-y-auto">
        {inventory.names.map((name) => <span key={name} title={name}
          className="max-w-full truncate rounded-md bg-[var(--surface)] px-2 py-1 font-mono text-xs">
          {name}
        </span>)}
      </div>
      : <p className="mt-2 text-xs text-[var(--muted)]">{t('gitSnapshotNoTags')}</p>}
    {inventory.total > inventory.names.length &&
      <p className="mt-2 text-xs text-[var(--muted)]">{t('gitSnapshotTagTruncated')}</p>}
  </div>
}

/** Used both by the repository view and by historical Activity details. */
export function GitInspectionView({ data }: { data: LocalGitInspection }) {
  const { t } = useTranslation()
  const fields = [
    { label: t('gitSnapshotBranch'), value: data.detached
      ? t('gitSnapshotDetached') : data.branch ?? t('gitSnapshotUnborn') },
    { label: t('gitSnapshotCommit'), value: data.commit ? data.commit.slice(0, 12) : t('gitSnapshotUnborn') },
    { label: t('gitSnapshotUpstream'), value: data.upstream ?? t('gitSnapshotNoUpstream') },
    { label: t('gitSnapshotAhead'), value: data.ahead ?? '—' },
    { label: t('gitSnapshotBehind'), value: data.behind ?? '—' },
    { label: t('gitSnapshotStaged'), value: data.staged },
    { label: t('gitSnapshotModified'), value: data.unstaged },
    { label: t('gitSnapshotUntracked'), value: data.untracked },
    { label: t('gitSnapshotConflicts'), value: data.conflicted }
  ]
  return <section className="mt-4 space-y-3" aria-label={t('gitSnapshotTitle')}>
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h4 className="text-sm font-semibold">{t('gitSnapshotTitle')}</h4>
      <span className="text-xs text-[var(--muted)]">
        {t('gitSnapshotAt')}: {new Date(data.inspectedAt).toLocaleString()}
      </span>
    </div>
    <dl className="grid grid-cols-2 gap-2 sm:grid-cols-3">
      {fields.map(({ label, value }) => <div key={label} className="min-w-0 rounded-lg border border-[var(--border)] px-3 py-2">
        <dt className="text-[11px] text-[var(--muted)]">{label}</dt>
        <dd className="mt-1 truncate font-mono text-xs" title={String(value)}>{value}</dd>
      </div>)}
    </dl>
    <div className="grid gap-2 md:grid-cols-2">
      <Tags inventory={data.localTags} title={t('gitSnapshotLocalTags')}/>
      {data.remoteTags.state === 'available'
        ? <Tags inventory={data.remoteTags} title={t('gitSnapshotRemoteTags')}/>
        : <div className="rounded-lg border border-[var(--border)] p-3">
          <h5 className="text-xs font-semibold">{t('gitSnapshotRemoteTags')}</h5>
          <p className="mt-2 text-xs text-[var(--muted)]">
            {t(data.remoteTags.state === 'unavailable'
              ? 'gitSnapshotRemoteUnavailable' : 'gitSnapshotRemoteNotRequested')}
          </p>
        </div>}
    </div>
  </section>
}
