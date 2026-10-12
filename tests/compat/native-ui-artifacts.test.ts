import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { validateArtifactPaths, verifyUiArtifacts, type UiArtifactManifest } from '../../scripts/native-ui-artifacts.mjs'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))) })
const hash = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex')
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-ui-artifacts-')); roots.push(root)
  const contents = { 'index.html': '<div id="root"></div>', 'graph.json': '{}', 'assets/chunks/client.js': 'export const v=1;', 'licenses/dsh.txt': 'MIT' }
  for (const [path, body] of Object.entries(contents)) {
    await mkdir(join(root, path, '..'), { recursive: true }); await writeFile(join(root, path), body)
  }
  const manifest: UiArtifactManifest = { schema: 1, dshVersion: '0.2.0-rc.2', revision: 'abc123', entryHtml: 'index.html', graphPath: 'graph.json', licenses: ['licenses/dsh.txt'], assets: Object.entries(contents).map(([path, body]) => ({ path, bytes: Buffer.byteLength(body), sha256: hash(body), sourcePackage: '@deepseek-ai/dsh-web-frontend', sourceVersion: '0.2.0-rc.2' })) }
  return { root, manifest }
}

test.each(['../x.js', '/x.js', 'https://x/x.js', 'a/%2e%2e/x.js', 'a/%252e%252e/x.js', 'a/../b.js', 'a\\b.js', 'a//b.js', './x.js', 'x.js?rev=a', 'x.js#x', 'a\0b', 'C:/x.js', 'a/%2fx.js', ''])('reject unsafe resource path %j', path => {
  expect(() => validateArtifactPaths([path])).toThrow()
})
test('reject duplicate paths', () => { expect(() => validateArtifactPaths(['assets/a.js', 'assets/a.js'])).toThrow() })
test('accept nested resources without flattening their relative paths', async () => {
  const { root, manifest } = await fixture(); await expect(verifyUiArtifacts(root, manifest)).resolves.toBeUndefined()
  expect(await readFile(join(root, 'assets/chunks/client.js'), 'utf8')).toBe('export const v=1;')
})
test('detect a one-byte content change of equal length', async () => {
  const { root, manifest } = await fixture(); await writeFile(join(root, 'assets/chunks/client.js'), 'export const v=2;')
  await expect(verifyUiArtifacts(root, manifest)).rejects.toThrow(/integrity/i)
})
test('reject symlink resources and symlink ancestors even inside the output root', async () => {
  const { root, manifest } = await fixture()
  await rm(join(root, 'assets/chunks/client.js')); await symlink('../../index.html', join(root, 'assets/chunks/client.js'))
  await expect(verifyUiArtifacts(root, manifest)).rejects.toThrow(/symbolic/i)
  await rm(join(root, 'assets/chunks'), { recursive: true }); await mkdir(join(root, 'real')); await symlink('../real', join(root, 'assets/chunks'))
  await expect(verifyUiArtifacts(root, manifest)).rejects.toThrow(/symbolic/i)
})
test('reject entry, graph and license references outside the hashed set', async () => {
  const { root, manifest } = await fixture()
  for (const broken of [{ ...manifest, entryHtml: 'missing.html' }, { ...manifest, graphPath: 'missing.json' }, { ...manifest, licenses: ['missing.txt'] }]) {
    await expect(verifyUiArtifacts(root, broken)).rejects.toThrow(/unlisted/i)
  }
})

import { collectUiArtifacts } from '../../scripts/native-ui-artifacts.mjs'
async function collectionFixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-ui-collect-')); roots.push(root)
  for (const name of ['dsh-web-frontend', 'dsh-client-modules']) {
    const pkg = join(root, 'node_modules/@deepseek-ai', name)
    await mkdir(pkg, { recursive: true })
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ name: '@deepseek-ai/' + name, version: '0.2.0-rc.2' }))
    await writeFile(join(pkg, 'LICENSE'), 'MIT license fixture')
  }
  const dist = join(root, 'node_modules/@deepseek-ai/dsh-web-frontend/dist')
  await mkdir(join(dist, 'assets'), { recursive: true })
  await writeFile(join(dist, 'index.html'), '<script type="module" src="./assets/main.js"></script>')
  await writeFile(join(dist, 'assets/main.js'), 'import "./chunk.js";')
  await writeFile(join(dist, 'assets/chunk.js'), 'export const exactBytes = 1;\n')
  const url = 'plugins/??@deepseek-ai/dsh-client-modules/client.js&rev=123'
  const inventory = { dshVersion: '0.2.0-rc.2', graph: { rev: '123', entries: [], batches: [] }, injections: [], resources: [{ url, packages: ['@deepseek-ai/dsh-client-modules'] }] }
  const request: typeof fetch = async (input, init) => {
    if (String(input).endsWith('/inventory')) return Response.json(inventory)
    expect(JSON.parse(init!.body as string)).toEqual({ url })
    return new Response('window.__ModuleLoader__.load({id:"fixture"});\n')
  }
  return { root, outputDir: join(root, 'output'), fixtureOrigin: 'http://127.0.0.1:12345', fetch: request, runtimeRoot: root, url, inventory }
}
test('collector preserves original shell bytes, nested files and exact combo URL identity', async () => {
  const setup = await collectionFixture(), manifest = await collectUiArtifacts(setup)
  await expect(verifyUiArtifacts(setup.outputDir, manifest)).resolves.toBeUndefined()
  expect(await readFile(join(setup.outputDir, 'assets/chunk.js'), 'utf8')).toBe('export const exactBytes = 1;\n')
  const resource = manifest.assets.find(row => row.url === setup.url)!
  expect(await readFile(join(setup.outputDir, resource.path), 'utf8')).toBe('window.__ModuleLoader__.load({id:"fixture"});\n')
  expect(manifest.licenses).toHaveLength(2)
  await expect(collectUiArtifacts(setup)).rejects.toThrow(/EEXIST/)
})
test('collector fails a missing advertised bundle', async () => {
  const setup = await collectionFixture()
  await expect(collectUiArtifacts({ ...setup, fetch: async (url, init) => init?.method === 'POST' ? new Response(null, { status: 404 }) : setup.fetch(url, init) })).rejects.toThrow(/missing/i)
})
test('collector never follows an off-origin inventory bundle', async () => {
  const setup = await collectionFixture(); setup.inventory.resources[0]!.url = 'https://remote.invalid/secret'
  await expect(collectUiArtifacts(setup)).rejects.toThrow(/bundle URL/)
})
test('collector refuses a different release and a production inventory origin', async () => {
  const setup = await collectionFixture()
  await expect(collectUiArtifacts({ ...setup, fixtureOrigin: 'https://production.invalid' })).rejects.toThrow(/loopback/)
  setup.inventory.dshVersion = '0.2.0-rc.3'
  await expect(collectUiArtifacts(setup)).rejects.toThrow(/Unsupported/)
})
test('collector rejects a graph whose advertised entry has no collected resource', async () => {
  const setup = await collectionFixture()
  const graph = setup.inventory.graph as { rev: string; entries: unknown[]; batches: unknown[] }
  graph.entries.push({ id: '@deepseek-ai/dsh-client-modules', url: 'plugins/missing.js?rev=123', rev: '123' })
  await expect(collectUiArtifacts(setup)).rejects.toThrow(/Uncollected graph resource/)
})
