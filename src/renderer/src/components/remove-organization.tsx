import { useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useNavigate } from '@tanstack/react-router'
import { Trash2 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'
import { errorMessage } from '../lib/utils'

export function RemoveOrganization({ login }: { login: string }) {
  const [open, setOpen] = useState(false)
  const { t } = useTranslation()
  const cache = useQueryClient()
  const navigate = useNavigate()
  const mutation = useMutation({
    mutationFn: () => window.spindle.removeOrganization(login),
    onSuccess: async () => {
      await cache.invalidateQueries({ queryKey: ['workspace'] })
      setOpen(false)
      await navigate({ to: '/' })
    }
  })
  return <Dialog open={open} onOpenChange={setOpen}>
    <Button variant="ghost" size="sm" onClick={() => setOpen(true)}><Trash2 className="size-3.5"/>{t('remove')}</Button>
    <DialogContent>
      <DialogTitle className="text-lg font-semibold">{t('removeOrganization')}</DialogTitle>
      <DialogDescription className="mt-3 text-sm text-[var(--muted)]">{t('removeOrganizationDetails')}</DialogDescription>
      <p className="mt-4 font-medium">{login}</p>
      {mutation.error && <p role="alert" className="mt-3 text-sm text-red-400">{errorMessage(mutation.error)}</p>}
      <div className="mt-6 flex justify-end gap-2">
        <Button variant="secondary" onClick={() => setOpen(false)}>{t('cancel')}</Button>
        <Button variant="destructive" disabled={mutation.isPending} onClick={() => mutation.mutate()}>{t('remove')}</Button>
      </div>
    </DialogContent>
  </Dialog>
}
