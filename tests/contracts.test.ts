import test from 'node:test'
import assert from 'node:assert/strict'
import {
  parseGitHubUrl, validateLogin, validateRepository, validatePage
} from '../src/shared/contracts'

test('validates organization and repository identifiers', () => {
  assert.equal(validateLogin('ZekStack'), 'ZekStack')
  assert.equal(validateRepository('my_repo.io'), 'my_repo.io')
  for (const name of ['../danger', 'org/repo', 'with space', '', '---', '-leading']) {
    assert.throws(() => validateLogin(name))
  }
  for (const name of ['../../repo', 'foo/bar', '.', '..', '']) {
    assert.throws(() => validateRepository(name))
  }
})

test('accepts finite repository pagination only', () => {
  assert.equal(validatePage(1), 1)
  assert.equal(validatePage(1000), 1000)
  for (const page of [0, -1, 1.5, NaN, Infinity, '1', 1001]) {
    assert.throws(() => validatePage(page))
  }
})

test('only approved HTTPS GitHub URLs open in external browser', () => {
  assert.equal(parseGitHubUrl('https://github.com/ZekStack/spindle'), 'https://github.com/ZekStack/spindle')
  for (const url of [
    'file:///etc/passwd', 'https://github.com.evil.test/project',
    'https://evil.test/github.com', 'javascript:alert(1)',
    'http://github.com/ZekStack/spindle', 'https://user:pass@github.com/',
    'https://github.com:444/project'
  ]) assert.throws(() => parseGitHubUrl(url))
})
