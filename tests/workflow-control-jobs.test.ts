import test from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JobManager } from '../src/main/jobs'
import { WorkflowMutationUncertainError, WorkflowPreflightError } from '../src/main/github'
import type { WorkflowControlRequest } from '../src/shared/workflow-controls'
import type { JobRecord } from '../src/shared/jobs'

const SHA = 'a'.repeat(40)
const BLOB = 'b'.repeat(40)
const SECRET = 'DO_NOT_PERSIST_THIS_INPUT'
const dispatch: WorkflowControlRequest = {
  action: 'dispatch', workflowId: 21, ref: 'main', refType: 'branch',
  expectedRefOid: SHA, expectedDefaultBlobSha: BLOB,
  expectedSourceBlobSha: BLOB, inputs: { version: SECRET }
}
const rerun: WorkflowControlRequest = {
  action: 'rerun-failed', workflowId: 21, runId: 50, expectedHeadSha: SHA,
  expectedAttempt: 2, expectedStatus: 'completed', expectedConclusion: 'failure'
}
function fixture(mutate: (request: WorkflowControlRequest, signal: AbortSignal) => Promise<void>) {
  const folder = mkdtempSync(join(tmpdir(), 'spindle-workflow-control-'))
  const path = join(folder, 'jobs.json')
  const github = {
    repository: async () => ({} as never),
    releases: async () => [],
    workflowRuns: async () => [],
    mutateWorkflowControl: async (_owner: string, _repo: string,
      request: WorkflowControlRequest, signal: AbortSignal) => mutate(request, signal)
  }
  const manager = new JobManager(path, github)
  const cleanup = () => rmSync(folder, { recursive: true, force: true })
  return { manager, path, github, cleanup }
}
async function done(manager: JobManager): Promise<JobRecord> {
  for (let attempts = 0; attempts < 100; attempts++) {
    const job = manager.list()[0]
    if (job && !['queued','running'].includes(job.phase)) return job
    await new Promise<void>(resolve => setTimeout(resolve, 5))
  }
  throw new Error('Control job did not settle')
}

test('workflow dispatch retains identifiers, not confidential inputs, and survives restart', async () => {
  const received: WorkflowControlRequest[] = []
  const { manager, path, github, cleanup } = fixture(async request => {
    received.push(request)
  })
  try {
    const queued = manager.controlWorkflow('TestOrg','demo',dispatch)
    assert.equal(queued.kind, 'github-workflow-control')
    assert.equal(JSON.stringify(queued).includes(SECRET), false)
    assert.equal(readFileSync(path, 'utf8').includes(SECRET), false)
    const finished = await done(manager)
    assert.equal(finished.phase, 'completed')
    assert.equal(received.length, 1)
    assert.equal(received[0].action, 'dispatch')
    if (received[0].action !== 'dispatch') throw new Error('Expected dispatch')
    assert.deepEqual({ ...received[0].inputs }, dispatch.inputs)
    assert.equal(readFileSync(path, 'utf8').includes(SECRET), false)
    const reopened = new JobManager(path, github)
    assert.equal(reopened.list()[0].workflowControl?.action, 'dispatch')
    assert.throws(() => reopened.controlWorkflow('TestOrg','demo',dispatch), /Recent workflow action/)
    assert.equal(JSON.stringify(reopened.list()).includes(SECRET), false)
  } finally { cleanup() }
})

test('preflight failures have safe failed state; transport uncertainty is partial and nonretryable', async () => {
  for (const [error, expected, code] of [
    [new WorkflowPreflightError('Workflow run changed since confirmation'), 'failed', 'workflow-stale'],
    [new WorkflowMutationUncertainError(), 'partial', 'workflow-uncertain']
  ] as const) {
    const { manager, path, cleanup } = fixture(async () => { throw error })
    try {
      manager.controlWorkflow('TestOrg','demo',rerun)
      const final = await done(manager)
      assert.equal(final.phase, expected)
      assert.equal(final.errorCode, code)
      assert.equal(final.retryable, false)
      assert.equal(readFileSync(path,'utf8').includes(SECRET), false)
    } finally { cleanup() }
  }
})

test('canceling the local control request never claims to have canceled the remote workflow', async () => {
  let onStarted!: () => void
  const started = new Promise<void>(resolve => { onStarted = resolve })
  const { manager, cleanup } = fixture(async (_request, signal) => {
    onStarted()
    await new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
    })
  })
  try {
    const queued = manager.controlWorkflow('TestOrg','demo',rerun)
    await started
    const stopped = manager.cancel(queued.id)
    assert.equal(stopped.phase, 'partial')
    assert.equal(stopped.errorCode, 'workflow-uncertain')
    assert.equal(stopped.retryable, false)
    assert.match(stopped.output.join(' '), /verify the Actions run/i)
  } finally { cleanup() }
})

test('restart marks started workflow request uncertain without resending it', () => {
  const folder = mkdtempSync(join(tmpdir(), 'spindle-workflow-restart-'))
  const path = join(folder, 'jobs.json')
  const { inputs, ...safe } = dispatch
  const stored: JobRecord = {
    id: randomUUID(), repository: 'TestOrg/demo', kind: 'github-workflow-control',
    action: 'workflow-control', workflowControl: safe,
    requestedAt: new Date().toISOString(), startedAt: new Date().toISOString(),
    finishedAt: null, phase: 'running', progress: 20,
    output: ['Checking current Actions state.'], errorCode: null, retryable: false
  }
  const github = {
    repository: async () => ({} as never), releases: async () => [],
    workflowRuns: async () => []
  }
  try {
    writeFileSync(path, JSON.stringify([stored]))
    const manager = new JobManager(path, github)
    assert.equal(manager.list()[0].phase, 'partial')
    assert.equal(manager.list()[0].errorCode, 'workflow-uncertain')
    assert.equal(manager.list()[0].retryable, false)
  } finally { rmSync(folder, { recursive: true, force: true }) }
})

test('workflow control holds the same-repository mutation lock against draft release creation', () => {
  const { manager, cleanup } = fixture(async () => {})
  try {
    manager.controlWorkflow('TestOrg', 'demo', rerun)
    assert.throws(() => manager.mutateRelease('TestOrg', 'demo', {
      action: 'create-draft', tagName: 'v1.0.0',
      expectedTagOid: SHA, name: 'Draft release', body: ''
    }), /already running/)
    assert.throws(() => manager.controlWorkflow('TestOrg', 'demo', rerun), /already running/)
  } finally { cleanup() }
})
