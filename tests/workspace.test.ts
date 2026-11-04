import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceStore } from '../src/main/store'

function withStore(fn: (store: WorkspaceStore, file: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'spindle-workspace-'))
  const file = join(dir, 'workspace.json')
  try { fn(new WorkspaceStore(file), file) }
  finally { rmSync(dir, { recursive: true, force: true }) }
}

test('organizations and tracked repositories are stored, restored and deduplicated', () => {
  withStore((store, file) => {
    assert.deepEqual(store.load(), { organizations: [], trackedRepositories: [] })
    store.addOrganization('ZekStack')
    store.addOrganization('zekstack')
    assert.deepEqual(store.load().organizations, ['ZekStack'])
    store.trackRepository('zekstack', 'tempo', true)
    store.trackRepository('ZekStack', 'tempo', true)
    assert.deepEqual(store.load().trackedRepositories, ['ZekStack/tempo'])
    const onDisk = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(onDisk.trackedRepositories[0], 'ZekStack/tempo')
    store.trackRepository('ZekStack', 'tempo', false)
    assert.deepEqual(store.load().trackedRepositories, [])
  })
})

test('removing an organization untracks its repositories without modifying GitHub', () => {
  withStore((store) => {
    store.addOrganization('ZekStack')
    store.addOrganization('ExampleOrg')
    store.trackRepository('ZekStack', 'tempo', true)
    store.trackRepository('ExampleOrg', 'project', true)
    const result = store.removeOrganization('ZekStack')
    assert.deepEqual(result.organizations, ['ExampleOrg'])
    assert.deepEqual(result.trackedRepositories, ['ExampleOrg/project'])
  })
})

test('rejects path traversal, invalid state and unregistered organization', () => {
  withStore((store, file) => {
    assert.throws(() => store.addOrganization('../bad'))
    assert.throws(() => store.trackRepository('unknown', 'repo', true), /organization/i)
    store.addOrganization('ZekStack')
    assert.throws(() => store.trackRepository('ZekStack', '../repo', true))
    writeFileSync(file, '{invalid json')
    assert.throws(() => store.load())
    assert.equal(readFileSync(file, 'utf8'), '{invalid json')
  })
})
