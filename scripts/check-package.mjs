import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { verifyRuntimeImports } from './package-import-guard.ts'

const expected = JSON.parse(readFileSync('packages/plugin/package.json', 'utf8'))
const candidatePath = process.argv[2] ?? process.env.WEB_CONTROL_CANDIDATE_DIR
const candidate = candidatePath ? resolve(candidatePath) : undefined
const buildRoot = candidate ? resolve(candidate, 'plugin') : resolve('packages/plugin')
const tgz = resolve(candidate ?? 'dist', `${expected.name}-${expected.version}.tgz`)
const entries = execFileSync('tar', ['-tzf', tgz], { encoding: 'utf8' }).trim().split('\n')
assert(entries.every(file => /^package\/(dist\/[^\s]+|package\.json|cordis\.patch\.yml|LICENSE|THIRD_PARTY_NOTICES\.md|README\.md)$/.test(file)), 'unexpected packed file')
assert(entries.includes('package/dist/index.js') && entries.includes('package/dist/client/index.js'), 'missing entry')
const read = file => execFileSync('tar', ['-xOzf', tgz, 'package/' + file], { encoding: 'utf8' })
const manifest = JSON.parse(read('package.json'))
assert.equal(manifest.name, 'dsh-web-control')
assert.equal(manifest.version, expected.version, 'stale plugin archive version')
assert.deepEqual(manifest.dsh.bundle.patch, ['./cordis.patch.yml'])
assert.deepEqual(manifest.dsh.client, { platform: 'web', inject: [
  '@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-connection'] })
assert.equal(Object.keys(manifest.dependencies ?? {}).length, 0, 'plugin must not install core dependencies')
assert.equal(manifest.peerDependencies['@deepseek-ai/dsh'], '0.2.0-rc.2')
assert.equal((read('cordis.patch.yml').match(/\bid:/g) ?? []).length, 1)
assert(read('cordis.patch.yml').includes(`id: web-control\n      name: ./dist/host-${manifest.version}.js`), 'stale bundle Host specifier')
assert(entries.includes(`package/dist/host-${manifest.version}.js`), 'missing versioned Host entry')
for (const entry of entries.filter(file => file.endsWith('.js'))) {
  const content = read(entry.slice('package/'.length))
  assert.equal(content, readFileSync(resolve(buildRoot, entry.slice('package/'.length)), 'utf8'), 'stale archive build entry')
  verifyRuntimeImports(content)
}
assert(!read('dist/client/index.js').includes('node:'), 'browser entry contains Host imports')
console.log(JSON.stringify({ package: manifest.name, version: manifest.version,
  sha256: createHash('sha256').update(readFileSync(tgz)).digest('hex'), entries: entries.length, verified: true }))
