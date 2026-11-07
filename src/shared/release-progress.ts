import type { JobPhase } from './jobs'
import type { ReleaseAction } from './releases'
import { TAG_OID_PATTERN, validateTagName } from './tags'

/** Historical attempt context; never includes workflow inputs, notes, asset paths or tokens. */
export interface ReleaseProgressTarget {
  jobId: string
  kind: 'tag-push' | 'dispatch' | 'api'
  releaseAction: ReleaseAction | null
  tagName: string
  expectedTagOid: string | null
  workflowId: number | null
  dispatchRef: string | null
  startedAt: string
  phase: JobPhase
}

export interface ReleaseRunEvidence {
  id: number
  workflowId: number
  event: string
  status: string
  conclusion: string | null
  headSha: string
  headBranch: string | null
  createdAt: string
  htmlUrl: string
}

/** Explicitly separate verified tag/run evidence from mere temporal candidates. */
export type RunCorrelation = 'verified' | 'candidate' | 'ambiguous' | 'none' | 'unavailable'
export type TagEvidence = 'matched' | 'changed' | 'absent' | 'unavailable'
export type ReleaseEvidence = 'draft' | 'published' | 'prerelease' | 'absent' | 'unavailable'
export type ReleaseOutcome = 'queued' | 'running' | 'published' | 'draft' | 'tag-only' |
  'failed' | 'uncertain' | 'no-run' | 'timed-out' | 'release-deleted'
export type RecoveryStep = 'inspect-release' | 'inspect-tag' | 'inspect-actions' |
  'verify-manually' | 'none'

export interface ReleaseProgressSnapshot {
  target: ReleaseProgressTarget
  checkedAt: string
  tag: {
    state: TagEvidence
    actualOid: string | null
    commitSha: string | null
  }
  release: {
    state: ReleaseEvidence
    id: number | null
    htmlUrl: string | null
    assetNames: string[]
    assetCount: number
  }
  run: {
    correlation: RunCorrelation
    matched: ReleaseRunEvidence | null
    candidateCount: number
    scanned: number
    truncated: boolean
  }
  outcome: ReleaseOutcome
  recovery: RecoveryStep
  /** Only unambiguous states are settled. Successful Actions runs can precede release publication. */
  settled: boolean
}

export function validateReleaseProgressTarget(target: ReleaseProgressTarget): ReleaseProgressTarget {
  validateTagName(target.tagName)
  if (target.expectedTagOid !== null && !TAG_OID_PATTERN.test(target.expectedTagOid)) {
    throw new Error('Invalid tag object reference')
  }
  if (target.workflowId !== null &&
      (!Number.isSafeInteger(target.workflowId) || target.workflowId <= 0)) {
    throw new Error('Invalid workflow identifier')
  }
  if (!Number.isFinite(Date.parse(target.startedAt))) throw new Error('Invalid release attempt date')
  return target
}

/**
 * Conservative interpretation: a Release proves publication; a GitHub run
 * proves its own result, not publication. A dispatch candidate is never a
 * verified run even if its status is completed or failed.
 */
export function classifyReleaseProgress(
  target: ReleaseProgressTarget, tag: TagEvidence, release: ReleaseEvidence,
  correlation: RunCorrelation, run: ReleaseRunEvidence | null
): Pick<ReleaseProgressSnapshot, 'outcome' | 'recovery' | 'settled'> {
  if (target.phase === 'queued') return { outcome: 'queued', recovery: 'none', settled: false }
  if (target.phase === 'running') return { outcome: 'running', recovery: 'none', settled: false }
  if (tag === 'changed') return { outcome: 'uncertain', recovery: 'verify-manually', settled: true }
  if (target.releaseAction === 'delete-release') {
    if (release === 'absent' && tag === 'matched') {
      return { outcome: 'release-deleted', recovery: 'inspect-tag', settled: true }
    }
    return { outcome: 'uncertain', recovery: 'inspect-release', settled: release !== 'unavailable' }
  }
  if (target.releaseAction === 'edit-notes' || target.releaseAction === 'upload-asset') {
    // A matching Release proves existence, not that free-form notes or a
    // specific asset upload succeeded. Those values are intentionally not
    // persisted, so the user must inspect the resulting Release.
    return { outcome: 'uncertain', recovery: 'inspect-release',
      settled: release !== 'unavailable' }
  }
  if (target.releaseAction === 'publish' && release === 'draft') {
    return { outcome: 'uncertain', recovery: 'inspect-release', settled: false }
  }
  if (release === 'published' || release === 'prerelease') {
    return { outcome: 'published', recovery: 'inspect-release', settled: true }
  }
  if (release === 'draft') {
    return { outcome: 'draft', recovery: 'inspect-release',
      settled: target.kind === 'api' && target.releaseAction === 'create-draft' }
  }
  if (correlation === 'verified' && run?.status === 'completed' &&
      run.conclusion && run.conclusion !== 'success') {
    return { outcome: 'failed', recovery: 'inspect-actions', settled: true }
  }
  if (target.kind === 'api') {
    return { outcome: 'uncertain', recovery: 'verify-manually', settled: false }
  }
  if (tag === 'matched') {
    if (target.kind === 'tag-push' && correlation === 'none') {
      return { outcome: 'tag-only', recovery: 'inspect-tag', settled: false }
    }
    return { outcome: 'uncertain', recovery: 'inspect-actions', settled: false }
  }
  return { outcome: 'uncertain', recovery: 'verify-manually', settled: false }
}

/** Stable selection: do not invent a run link for ambiguous candidates. */
export function correlateReleaseRuns(
  target: ReleaseProgressTarget, commitSha: string | null,
  runs: ReleaseRunEvidence[], truncated: boolean
): ReleaseProgressSnapshot['run'] {
  if (!target.workflowId) return {
    correlation: 'none', matched: null, candidateCount: 0, scanned: 0, truncated: false
  }
  const started = Date.parse(target.startedAt)
  const relevant = runs.filter(run => run.workflowId === target.workflowId &&
    Date.parse(run.createdAt) >= started - 30_000 &&
    Date.parse(run.createdAt) <= started + 20 * 60_000)
  const verified = target.kind === 'tag-push' && commitSha
    ? relevant.filter(run => run.event === 'push' && run.headSha === commitSha &&
        run.headBranch === target.tagName)
    : []
  if (verified.length === 1) return {
    correlation: 'verified', matched: verified[0], candidateCount: 1,
    scanned: runs.length, truncated
  }
  if (verified.length > 1) return {
    correlation: 'ambiguous', matched: null, candidateCount: verified.length,
    scanned: runs.length, truncated
  }
  // The workflow_dispatch endpoint returns 204, not a run ID. A matching
  // workflow/ref/time window is a candidate only, never proven causation.
  const candidates = target.kind === 'dispatch'
    ? relevant.filter(run => run.event === 'workflow_dispatch' &&
        run.headBranch === target.dispatchRef)
    : []
  if (candidates.length === 1) return {
    correlation: 'candidate', matched: candidates[0], candidateCount: 1,
    scanned: runs.length, truncated
  }
  return {
    correlation: candidates.length > 1 ? 'ambiguous' : truncated ? 'unavailable' : 'none',
    matched: null, candidateCount: candidates.length,
    scanned: runs.length, truncated
  }
}

/** Finite UI observation window; expiry describes observation, not the remote job. */
export const RELEASE_POLL_MAX_CHECKS = 30
export const RELEASE_POLL_MAX_MS = 10 * 60_000
export function releasePollDelay(checks: number): number {
  return Math.min(30_000, Math.floor(4_000 * (1.3 ** Math.min(checks, 20))))
}
