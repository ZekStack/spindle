import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { WorkflowSource, WorkflowRunSummary } from '../../../shared/workflow-discovery'
import type { WorkflowControlAction, WorkflowDispatchPreview, WorkflowRefType } from '../../../shared/workflow-controls'
import { workflowActionAllowed } from '../../../shared/workflow-controls'
import { Button } from './ui/button'
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './ui/dialog'

type BaseProps = {
  owner: string
  name: string
  onAccepted(): void
}

const inputName = (name: string): string => name

/** Two-stage preview and confirmation. Values stay in renderer state and transient main memory only. */
export function WorkflowDispatchControl({ owner, name, source, onAccepted, authenticated }:
  BaseProps & { source: WorkflowSource; authenticated: boolean }) {
  const { t } = useTranslation()
  const [ref, setRef] = useState(source.branch)
  const [refType, setRefType] = useState<WorkflowRefType>('branch')
  const [preview, setPreview] = useState<WorkflowDispatchPreview | null>(null)
  const [values, setValues] = useState<Record<string, string>>({})
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    setRef(source.branch)
    setRefType('branch')
    setPreview(null)
    setValues({})
    setConfirm(false)
    setError('')
  }, [owner, name, source.workflow.id, source.branch])
  const eligible = authenticated && source.workflow.state === 'active' &&
    source.sourceState === 'parsed' &&
    source.triggers.some(trigger => trigger.event === 'workflow_dispatch')

  async function check() {
    setBusy(true)
    setPreview(null)
    setValues({})
    setError('')
    try {
      const inspected = await window.spindle.previewWorkflowDispatch(
        owner, name, source.workflow.id, ref.trim(), refType)
      setPreview(inspected)
    } catch { setError(t('wfControlPreviewFailed')) }
    finally { setBusy(false) }
  }
  function changeInput(key: string, value: string) {
    setValues(previous => ({ ...previous, [key]: value }))
    setError('')
  }
  async function submit() {
    if (!preview || busy) return
    setBusy(true)
    setError('')
    try {
      await window.spindle.controlWorkflow(owner, name, {
        action: 'dispatch', workflowId: preview.workflowId,
        ref: preview.ref, refType: preview.refType,
        expectedRefOid: preview.refOid,
        expectedDefaultBlobSha: preview.defaultBlobSha,
        expectedSourceBlobSha: preview.sourceBlobSha,
        inputs: values
      })
      setConfirm(false)
      setPreview(null)
      setValues({})
      onAccepted()
    } catch { setError(t('wfControlSubmitFailed')) }
    finally { setBusy(false) }
  }

  return <div className="space-y-3 rounded-lg border border-[var(--border)] p-3">
    <h4 className="text-sm font-semibold">{t('wfControlDispatchTitle')}</h4>
    <p className="text-xs text-[var(--muted)]">{t('wfControlDispatchHint')}</p>
    <div className="flex flex-wrap items-end gap-2">
      <label className="min-w-40 flex-1 text-xs">{t('wfControlRef')}
        <input value={ref} maxLength={150} disabled={busy}
          onChange={e => { setRef(e.target.value); setPreview(null); setValues({}) }}
          className="mt-1 w-full rounded-lg border border-[var(--border)] bg-[var(--surface-2)] px-3 py-2 text-sm"/>
      </label>
      <label className="text-xs">{t('wfControlRefType')}
        <select value={refType} disabled={busy}
          onChange={e => { setRefType(e.target.value as WorkflowRefType); setPreview(null); setValues({}) }}
          className="mt-1 block rounded-lg border border-[var(--border)] bg-[var(--surface-2)] p-2 text-sm">
          <option value="branch">{t('wfControlBranch')}</option>
          <option value="tag">{t('wfControlTag')}</option>
        </select>
      </label>
      <Button size="sm" variant="secondary" disabled={!eligible || busy || !ref.trim()}
        onClick={() => void check()}>{t('wfControlVerify')}</Button>
    </div>
    {!authenticated && <p className="text-xs text-amber-400">{t('wfControlSignIn')}</p>}
    {authenticated && !eligible && <p className="text-xs text-amber-400">{t('wfControlDispatchUnavailable')}</p>}
    {preview && <div className="space-y-3 rounded-lg bg-[var(--surface-2)] p-3">
      <div className="space-y-1 text-xs">
        <p>{preview.workflowName} · {preview.refType}: <strong>{preview.ref}</strong></p>
        <p className="break-all font-mono">{t('wfControlRefSha')}: {preview.refOid}</p>
        <p className="break-all font-mono">{t('wfSourceBlob')}: {preview.sourceBlobSha}</p>
      </div>
      {preview.inputs.map(input => <label key={input.name} className="block space-y-1 text-xs">
        <span className="font-mono">{inputName(input.name)} {input.required ? `· ${t('wfRequired')}` : ''}
          {' · '}{input.type}</span>
        {input.description && <p className="text-[var(--muted)]">{input.description}</p>}
        {input.type === 'choice' && input.options.length ? <select
          value={values[input.name] ?? ''}
          onChange={e => changeInput(input.name, e.target.value)}
          className="block w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2">
          <option value="">{t('wfControlOmit')}</option>
          {input.options.map(option => <option key={option} value={option}>{option}</option>)}
        </select> : input.type === 'boolean' ? <select
          value={values[input.name] ?? ''}
          onChange={e => changeInput(input.name, e.target.value)}
          className="block w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] p-2">
          <option value="">{t('wfControlOmit')}</option>
          <option value="true">true</option><option value="false">false</option>
        </select> : <input
          type={input.type === 'number' ? 'number' : 'text'}
          value={values[input.name] ?? ''} maxLength={1024}
          onChange={e => changeInput(input.name, e.target.value)}
          className="block w-full rounded-lg border border-[var(--border)] bg-[var(--surface)] px-3 py-2"/>}
      </label>)}
      <p className="text-xs text-[var(--muted)]">{t('wfControlInputPrivacy')}</p>
      <Button size="sm" disabled={busy} onClick={() => { setConfirm(true); setError('') }}>
        {t('wfControlReviewDispatch')}
      </Button>
    </div>}
    {error && <p role="alert" className="text-xs text-red-400">{error}</p>}
    <Dialog open={confirm} onOpenChange={next => { if (!busy) setConfirm(next) }}>
      <DialogContent className="max-h-[85vh] overflow-y-auto">
        <DialogTitle>{t('wfControlConfirmDispatch')}</DialogTitle>
        <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
          {t('wfControlConfirmDispatchHint')}
        </DialogDescription>
        {preview && <div className="mt-3 space-y-2 break-all text-xs">
          <p>{owner}/{name} · {preview.workflowName}</p>
          <p>{preview.refType}: <strong>{preview.ref}</strong></p>
          <p className="font-mono">{preview.refOid}</p>
          <p>{t('wfControlInputCount', { count: Object.keys(values).length })}</p>
        </div>}
        <div className="mt-5 flex justify-end gap-2">
          <Button size="sm" variant="secondary" disabled={busy}
            onClick={() => setConfirm(false)}>{t('cancel')}</Button>
          <Button size="sm" disabled={busy || !preview}
            onClick={() => void submit()}>{t('wfControlConfirmDispatch')}</Button>
        </div>
        {error && <p role="alert" className="mt-3 text-xs text-red-400">{error}</p>}
      </DialogContent>
    </Dialog>
  </div>
}

/** One confirmation dialog for all visible run actions, not one dialog per row. */
export function WorkflowRunControlDialog({ owner, name, run, action, onClose, onAccepted }:
  BaseProps & { run: WorkflowRunSummary | null; action: Exclude<WorkflowControlAction, 'dispatch'> | null;
    onClose(): void }) {
  const { t } = useTranslation()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(false)
  useEffect(() => { setError(false) }, [run?.id, action])
  const valid = !!run && !!action && workflowActionAllowed(action, run.status, run.conclusion)
  async function send() {
    if (!run || !action || !valid || busy) return
    setBusy(true); setError(false)
    try {
      await window.spindle.controlWorkflow(owner, name, {
        action, workflowId: run.workflowId, runId: run.id,
        expectedHeadSha: run.headSha, expectedAttempt: run.attempt,
        expectedStatus: run.status, expectedConclusion: run.conclusion
      })
      onClose()
      onAccepted()
    } catch { setError(true) }
    finally { setBusy(false) }
  }
  return <Dialog open={!!run && !!action} onOpenChange={next => { if (!next && !busy) onClose() }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto">
      <DialogTitle>{t(action === 'cancel' ? 'wfControlCancel' :
        action === 'rerun' ? 'wfControlRerun' : 'wfControlRerunFailed')}</DialogTitle>
      <DialogDescription className="mt-2 text-sm text-[var(--muted)]">
        {t('wfControlRunHint')}
      </DialogDescription>
      {run && <div className="mt-3 space-y-2 break-all text-xs">
        <p>{owner}/{name} · {run.name}</p>
        <p>#{run.number} · {t('wfAttempt')} {run.attempt} · {run.status} · {run.conclusion ?? '—'}</p>
        <p className="font-mono">{run.headSha}</p>
        <p>{t('wfControlRunWarning')}</p>
      </div>}
      {!valid && <p role="alert" className="mt-2 text-xs text-red-400">
        {t('wfControlRunStale')}
      </p>}
      {error && <p role="alert" className="mt-2 text-xs text-red-400">
        {t('wfControlSubmitFailed')}
      </p>}
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" size="sm" disabled={busy} onClick={onClose}>{t('cancel')}</Button>
        <Button size="sm" disabled={!valid || busy} onClick={() => void send()}>
          {t(action === 'cancel' ? 'wfControlCancel' :
            action === 'rerun' ? 'wfControlRerun' : 'wfControlRerunFailed')}
        </Button>
      </div>
    </DialogContent>
  </Dialog>
}
