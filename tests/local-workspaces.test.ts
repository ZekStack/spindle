import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync,
  rmSync, symlinkSync, writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { githubOriginRepository, LocalWorkspaceStore } from '../src/main/local-workspaces'

function git(folder: string, ...args: string[]) {
  execFileSync('git', ['-C', folder, ...args], { stdio: 'pipe', timeout: 10_000 })
}
function folder() {
  return mkdtempSync(join(tmpdir(), 'spindle-local-root-'))
}
function checkout(root: string, name: string, origin: string): string {
  const path = join(root, name)
  mkdirSync(path)
  git(path, 'init', '-q')
  git(path, 'remote', 'add', 'origin', origin)
  return path
}

test('GitHub origin parser accepts only exact credential-free GitHub repository origins', () => {
  assert.equal(githubOriginRepository('https://github.com/ExampleOrg/project.git'),
    'ExampleOrg/project')
  assert.equal(githubOriginRepository('git@github.com:ExampleOrg/project.git'),
    'ExampleOrg/project')
  assert.equal(githubOriginRepository('ssh://git@github.com/ExampleOrg/project'),
    'ExampleOrg/project')
  for (const raw of [
    'https://github.com.evil.tld/a/b.git',
    'https://user:secret@github.com/a/b.git',
    'https://github.com/a/b.git?token=secret',
    'https://github.com/a/b.git#frag',
    'https://gitlab.com/a/b.git',
    'file:///home/user/repo',
    'git@github.com:a/../b',
    'git@github.com:a/b/c',
    'https://github.com/a%2Fb/c',
    'https://github.com:8443/a/b.git',
    'ssh://notgit@github.com/a/b.git',
    ''
  ]) {
    assert.equal(githubOriginRepository(raw), null, raw)
  }
})

test('multiple roots persist independently and removal does not delete folders', () => {
  const dir = folder()
  try {
    const file = join(dir, 'local-workspaces.json')
    const rootA = join(dir, 'a')
    const rootB = join(dir, 'b')
    mkdirSync(rootA)
    mkdirSync(rootB)
    const store = new LocalWorkspaceStore(file)
    assert.deepEqual(store.load(), { roots: [], repositories: [] })
    store.addRootFromPicker(rootA)
    store.addRootFromPicker(rootB)
    store.addRootFromPicker(rootA)
    assert.deepEqual(new LocalWorkspaceStore(file).load().roots, [resolve(rootA), resolve(rootB)])
    assert.throws(() => store.removeRoot(join(dir, 'unknown')), /not found/)
    store.removeRoot(resolve(rootA))
    assert.deepEqual(store.load().roots, [resolve(rootB)])
    assert.equal(existsSync(rootA), true)
    assert.equal(existsSync(rootB), true)
    assert.throws(() => store.addRootFromPicker(join(dir, 'missing')), /not available/)
    assert.deepEqual(store.load().roots, [resolve(rootB)])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('link and relink require matching actual Git origin and preserve associations on failure', async () => {
  const dir = folder()
  try {
    const file = join(dir, 'local-workspaces.json')
    const first = checkout(dir, 'first', 'https://github.com/ExampleOrg/project.git')
    const second = checkout(dir, 'second', 'git@github.com:exampleorg/PROJECT.git')
    const wrong = checkout(dir, 'wrong', 'https://github.com/other/thing.git')
    const nested = join(first, 'nested')
    mkdirSync(nested)
    const store = new LocalWorkspaceStore(file)
    store.addRootFromPicker(dir)
    await store.linkFromPicker('ExampleOrg/project', nested)
    assert.equal(store.pathFor('exampleorg/PROJECT'), resolve(first))
    assert.deepEqual(store.load().repositories, [
      { repository: 'ExampleOrg/project', path: resolve(first) }
    ])
    await assert.rejects(store.linkFromPicker('ExampleOrg/project', wrong), /origin/)
    assert.equal(store.pathFor('ExampleOrg/project'), resolve(first))
    await store.linkFromPicker('exampleorg/project', second)
    assert.equal(store.pathFor('ExampleOrg/PROJECT'), resolve(second))
    assert.deepEqual(new LocalWorkspaceStore(file).load().repositories,
      [{ repository: 'ExampleOrg/project', path: resolve(second) }])
    assert.deepEqual(store.removeRoot(resolve(dir)).roots, [])
    assert.equal(store.pathFor('ExampleOrg/project'), resolve(second))
    store.unlink('EXAMPLEORG/project')
    assert.deepEqual(store.load().repositories, [])
    assert.equal(existsSync(second), true)
    assert.throws(() => store.pathFor('ExampleOrg/project'), /no linked/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('non-Git folders and missing or malicious Git origins fail closed', async () => {
  const dir = folder()
  try {
    const file = join(dir, 'locations.json')
    const store = new LocalWorkspaceStore(file)
    const noRemote = join(dir, 'no-remote')
    mkdirSync(noRemote)
    git(noRemote, 'init', '-q')
    await assert.rejects(store.linkFromPicker('ExampleOrg/project', noRemote), /origin/)
    git(noRemote, 'remote', 'add', 'origin',
      'https://person:topsecret@github.com/ExampleOrg/project.git')
    await assert.rejects(store.linkFromPicker('ExampleOrg/project', noRemote), /origin/)
    // Invalid remote URLs and embedded credentials never reach persisted JSON.
    assert.equal(existsSync(file), false)
    assert.deepEqual(store.load().repositories, [])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('corrupt workspace preferences are never overwritten and missing paths remain saved', async () => {
  const dir = folder()
  try {
    const file = join(dir, 'local.json')
    const checkoutDir = checkout(dir, 'checkout', 'https://github.com/ExampleOrg/project.git')
    const store = new LocalWorkspaceStore(file)
    await store.linkFromPicker('ExampleOrg/project', checkoutDir)
    rmSync(checkoutDir, { recursive: true, force: true })
    assert.equal(store.pathFor('ExampleOrg/project'), resolve(checkoutDir))
    writeFileSync(file, '{invalid JSON')
    assert.throws(() => store.load())
    assert.throws(() => store.addRootFromPicker(dir))
    assert.equal(readFileSync(file, 'utf8'), '{invalid JSON')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('symlink-selected folders resolve to the same single stored location', () => {
  if (process.platform === 'win32') return // Unprivileged symlink creation is not universal.
  const dir = folder()
  try {
    const real = join(dir, 'real')
    const alias = join(dir, 'alias')
    mkdirSync(real)
    symlinkSync(real, alias, 'dir')
    const store = new LocalWorkspaceStore(join(dir, 'locations.json'))
    store.addRootFromPicker(real)
    store.addRootFromPicker(alias)
    assert.deepEqual(store.load().roots, [resolve(real)])
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
