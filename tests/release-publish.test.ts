import test from 'node:test'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('publishing is safe after GitHub HTTP 500, reruns and incomplete uploads', () => {
  const file = fileURLToPath(new URL('./helpers/simulate-release-publish.mjs', import.meta.url))
  execFileSync(process.execPath, [file], { encoding: 'utf8', timeout: 30_000 })
})
