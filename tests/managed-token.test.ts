import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ManagedGitHubTokenStore, type SecureCipher } from '../src/main/managed-token'

function secretStore(platform = 'linux', backend = 'gnome_libsecret') {
  const root = mkdtempSync(join(tmpdir(), 'spindle-secret-'))
  const path = join(root, 'secret.enc')
  const cipher: SecureCipher = {
    isAsyncEncryptionAvailable: async () => true,
    getSelectedStorageBackend: () => backend,
    encryptStringAsync: async (value) => Buffer.from('cipher:' + Buffer.from(value).toString('base64')),
    decryptStringAsync: async (data) => ({
      result: Buffer.from(data.toString().slice(7), 'base64').toString(),
      shouldReEncrypt: false
    })
  }
  const store = new ManagedGitHubTokenStore(cipher, () => path, platform)
  return { store, path, cleanup: () => rmSync(root, { force: true, recursive: true }) }
}

test('managed token is OS-encrypted and never stored in readable workspace data', async () => {
  const { store, path, cleanup } = secretStore()
  const token = 'ghu_' + 'x'.repeat(36)
  try {
    await store.save(token)
    assert.equal(await store.load(), token)
    assert.equal(readFileSync(path).includes(Buffer.from(token)), false)
    await store.clear()
    assert.equal(await store.load(), null)
  } finally { cleanup() }
})

test('Linux basic_text or unavailable keyring rejects storage without plaintext fallback', async () => {
  for (const backend of ['basic_text', 'unknown']) {
    const { store, cleanup } = secretStore('linux', backend)
    try {
      assert.equal(await store.available(), false)
      await assert.rejects(() => store.save('ghu_' + 'x'.repeat(36)), /unavailable/)
      assert.equal(await store.load(), null)
    } finally { cleanup() }
  }
})

test('OS-provided protected encryption is accepted on supported Windows and Linux backends', async () => {
  for (const [os, backend] of [
    ['win32', 'unknown'], ['linux', 'kwallet6']
  ]) {
    const { store, cleanup } = secretStore(os, backend)
    try { assert.equal(await store.available(), true) }
    finally { cleanup() }
  }
})

test('multiple managed identities survive restart and switch without exposing credentials', async () => {
  const { store, path, cleanup } = secretStore()
  const alice = 'ghu_' + 'a'.repeat(36)
  const bob = 'ghu_' + 'b'.repeat(36)
  try {
    await store.save(alice, 'Alice')
    await store.save(bob, 'Bob')
    assert.deepEqual(await store.accounts(), {
      logins: ['Alice', 'Bob'], activeLogin: 'Bob', legacyActive: false
    })
    assert.equal(await store.load(), bob)
    assert.equal(readFileSync(path).includes(Buffer.from(alice)), false)
    assert.equal(readFileSync(path).includes(Buffer.from(bob)), false)
    await store.select('aLiCe')
    assert.equal(await store.load(), alice)
    await store.select(null)
    assert.equal(await store.load(), null)
    assert.deepEqual((await store.accounts()).logins, ['Alice', 'Bob'])
    await store.select('Bob')
    await store.clear()
    assert.deepEqual(await store.accounts(), {
      logins: ['Alice'], activeLogin: 'Alice', legacyActive: false
    })
    assert.equal(await store.load(), alice)
    await store.remove('Alice')
    assert.equal(await store.load(), null)
    assert.deepEqual((await store.accounts()).logins, [])
  } finally { cleanup() }
})

test('older encrypted single-account token is preserved and attributed after GitHub verifies login', async () => {
  const { store, cleanup } = secretStore()
  const token = 'ghu_' + 'c'.repeat(36)
  try {
    await store.save(token)
    assert.deepEqual(await store.accounts(), {
      logins: [], activeLogin: null, legacyActive: true
    })
    assert.equal(await store.load(), token)
    await store.adoptLegacy('VerifiedUser')
    assert.deepEqual(await store.accounts(), {
      logins: ['VerifiedUser'], activeLogin: 'VerifiedUser', legacyActive: false
    })
    assert.equal(await store.load(), token)
  } finally { cleanup() }
})

test('account mutations serialize concurrent authorizations without losing either login', async () => {
  const { store, cleanup } = secretStore()
  try {
    await Promise.all([
      store.save('ghu_' + 'a'.repeat(36), 'Alice'),
      store.save('ghu_' + 'b'.repeat(36), 'Bob')
    ])
    const logins = (await store.accounts()).logins
    assert.deepEqual(logins, ['Alice', 'Bob'])
    await assert.rejects(() => store.select('Unknown'), /not found/)
    assert.deepEqual((await store.accounts()).logins, logins)
  } finally { cleanup() }
})

test('an insecure Linux keyring never reveals saved account identities or tokens', async () => {
  const { store, cleanup } = secretStore('linux', 'basic_text')
  try {
    assert.deepEqual(await store.accounts(), {
      logins: [], activeLogin: null, legacyActive: false
    })
    await assert.rejects(() => store.save('ghu_' + 'a'.repeat(36), 'Alice'), /unavailable/)
  } finally { cleanup() }
})
