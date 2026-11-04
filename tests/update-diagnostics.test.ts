import test from 'node:test'
import assert from 'node:assert/strict'
import {
  failedUpdateOperation, formatUpdateDiagnostics
} from '../src/shared/update-diagnostics'
import type { UpdatePhase, UpdateStatus } from '../src/shared/update-policy'

const state: UpdateStatus = {
  phase: 'error',
  currentVersion: '0.1.0-rc.8',
  availableVersion: '0.1.0-rc.9',
  percent: null,
  message: 'verification',
  installType: 'deb',
  failureStage: 'download'
}

test('failed operation is derived before changing updater phase', () => {
  const cases: [UpdatePhase, string][] = [
    ['checking', 'check'], ['available', 'check'],
    ['downloading', 'download'], ['ready', 'download'],
    ['installing', 'install']
  ]
  for (const [phase, expected] of cases) {
    assert.equal(failedUpdateOperation(phase), expected)
  }
})

test('diagnostics expose meaningful safe fields, including package and phase', () => {
  const report = formatUpdateDiagnostics(state, 'linux', Date.UTC(2026, 10, 4, 13, 0))
  assert.match(report, /Installer: deb/)
  assert.match(report, /Channel: rc/)
  assert.match(report, /Failed operation: download/)
  assert.match(report, /Error category: verification/)
  assert.match(report, /Last completed check: 2026-11-04T13:00:00.000Z/)
})

test('diagnostic report never copies arbitrary values from an invalid version or status', () => {
  const sensitive = 'ghp_SENSITIVESECRET /home/person/.config/spindle'
  const modified = {
    ...state,
    currentVersion: sensitive,
    availableVersion: sensitive,
    installType: sensitive,
    failureStage: sensitive,
    message: sensitive,
    phase: sensitive
  } as unknown as UpdateStatus
  const report = formatUpdateDiagnostics(modified, sensitive, Number.NaN)
  assert.equal(report.includes(sensitive), false)
  assert.equal(report.includes('SENSITIVESECRET'), false)
  assert.match(report, /Platform: unknown/)
  assert.match(report, /Channel: unknown/)
  assert.match(report, /Error category: unknown/)
  assert.match(report, /Last completed check: never/)
})

test('diagnostics work for a stable channel without a new release', () => {
  const report = formatUpdateDiagnostics({
    ...state, currentVersion: '0.1.0',
    availableVersion: null, phase: 'up-to-date',
    message: null, failureStage: null, installType: 'nsis'
  }, 'win32', null)
  assert.match(report, /Channel: stable/)
  assert.match(report, /Available version: none/)
  assert.match(report, /Error category: none/)
  assert.match(report, /Installer: nsis/)
})
