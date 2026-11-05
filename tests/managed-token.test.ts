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
