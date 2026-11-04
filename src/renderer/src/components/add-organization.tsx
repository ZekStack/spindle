import { useState, type FormEvent } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Plus } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { errorMessage } from '../lib/utils'

export function AddOrganization({ compact = false }: { compact?: boolean }) {
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState('')
  const navigate = useNavigate()
  const cache = useQueryClient()
  const { t } = useTranslation()
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
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setOpen(false)}>{t('cancel')}</Button>
          <Button type="submit" disabled={!value.trim() || mutation.isPending}>{t('add')}</Button>
        </div>
      </form>
    </DialogContent>
  </Dialog>
}
