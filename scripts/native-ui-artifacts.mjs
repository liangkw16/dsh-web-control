/** Immutable published browser resources. No upstream JavaScript rewriting or Host bundling. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const packageName = /^(?:@[a-z0-9._-]+\/)?[a-z0-9._-]+$/;
export function validateArtifactPaths(paths) {
  const seen = new Set();
  for (const path of paths) {
    if (typeof path !== 'string' || !path || /[\\%?#:\x00-\x20\x7f]/.test(path)
      || path.split('/').some(part => !part || part === '.' || part === '..') || seen.has(path)) {
      throw new Error('Unsafe or duplicate artifact path');
    }
    seen.add(path);
  }
}
async function regularFile(root, path) {
  validateArtifactPaths([path]);
  let current = root;
  const components = path.split('/');
  for (const [index, part] of components.entries()) {
    current = join(current, part);
    const stat = await lstat(current);
    if (stat.isSymbolicLink()) throw new Error('Symbolic artifact path');
    if (index < components.length - 1 ? !stat.isDirectory() : !stat.isFile()) throw new Error('Not a regular artifact file');
  }
  return current;
}
export async function verifyUiArtifacts(root, manifest) {
  if (manifest?.schema !== 1 || manifest.dshVersion !== '0.2.0-rc.2' || !manifest.revision
    || !Array.isArray(manifest.assets) || !Array.isArray(manifest.licenses)) throw new Error('Invalid UI manifest');
  if ((await lstat(root)).isSymbolicLink()) throw new Error('Symbolic artifact root');
  validateArtifactPaths(manifest.assets.map(row => row.path));
  validateArtifactPaths([manifest.entryHtml, manifest.graphPath, ...manifest.licenses]);
  const paths = new Set(manifest.assets.map(row => row.path));
  for (const path of [manifest.entryHtml, manifest.graphPath, ...manifest.licenses]) {
    if (!paths.has(path)) throw new Error('Unlisted UI entry, graph or license');
  }
  const urls = new Set();
  for (const row of manifest.assets) {
    if (!packageName.test(row.sourcePackage) || typeof row.sourceVersion !== 'string' || !row.sourceVersion
      || !/^[a-f0-9]{64}$/.test(row.sha256) || !Number.isSafeInteger(row.bytes) || row.bytes < 0) throw new Error('Invalid artifact metadata');
    if (row.url !== undefined) {
      validateResourceUrl(row.url);
      if (urls.has(row.url)) throw new Error('Duplicate artifact URL');
      urls.add(row.url);
    }
    const bytes = await readFile(await regularFile(root, row.path));
    if (bytes.length !== row.bytes || hash(bytes) !== row.sha256) throw new Error(`Artifact integrity failure: ${row.path}`);
  }
}
function validateResourceUrl(url) {
  if (typeof url !== 'string' || !url.startsWith('plugins/') || /[\\%#\x00-\x20]/.test(url)) throw new Error('Invalid bundle URL');
  const parsed = new URL(url, 'http://fixture.invalid/');
  if (parsed.origin !== 'http://fixture.invalid' || parsed.pathname.split('/').some(part => part === '..' || part === '.')
    || url.split('?')[0].split('/').some(part => part === '..' || part === '.')) throw new Error('Invalid bundle URL');
}
async function walk(root, prefix = '') {
  const out = [];
  for (const item of (await readdir(join(root, prefix), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
    const path = prefix + item.name;
    if (item.isSymbolicLink()) throw new Error('Symbolic source artifact');
    if (item.isDirectory()) out.push(...await walk(root, path + '/'));
    else if (item.isFile() && !path.endsWith('.map')) out.push(path);
  }
  return out;
}
export async function collectUiArtifacts({ runtimeRoot, outputDir, fixtureOrigin, fetch: request }) {
  const origin = new URL(fixtureOrigin);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) || origin.username || origin.password
    || origin.pathname !== '/' || origin.search || origin.hash) throw new Error('Inventory requires an isolated loopback origin');
  const response = await request(new URL('/api/web-control/native-ui/inventory', origin));
  if (!response.ok) throw new Error('Native UI inventory unavailable');
  const inventory = await response.json();
  if (inventory.dshVersion !== '0.2.0-rc.2' || !inventory.graph?.rev || !Array.isArray(inventory.resources)) throw new Error('Unsupported native UI inventory');
  if (!Array.isArray(inventory.graph.entries) || !Array.isArray(inventory.graph.batches)) throw new Error('Invalid resource graph');
  const resourceUrls = new Set(inventory.resources.map(row => row.url));
  for (const row of [...inventory.graph.entries, ...inventory.graph.batches]) {
    validateResourceUrl(row.url);
    if (!resourceUrls.has(row.url)) throw new Error('Uncollected graph resource');
  }
  // mkdir without recursive/exist_ok intentionally refuses replacement of prior evidence.
  await mkdir(outputDir);
  const manifest = { schema: 1, dshVersion: '0.2.0-rc.2', revision: inventory.graph.rev, entryHtml: 'index.html', graphPath: 'graph.json', assets: [], licenses: [] };
  const add = async (path, bytes, sourcePackage, sourceVersion, extra = {}) => {
    validateArtifactPaths([...manifest.assets.map(row => row.path), path]);
    await mkdir(dirname(join(outputDir, path)), { recursive: true });
    await writeFile(join(outputDir, path), bytes, { flag: 'wx' });
    manifest.assets.push({ path, sha256: hash(bytes), bytes: bytes.length, sourcePackage, sourceVersion, ...extra });
  };
  const packages = new Map();
  const readPackage = async id => {
    if (!packageName.test(id)) throw new Error('Invalid source package');
    if (packages.has(id)) return packages.get(id);
    // Resolve the public npm package symlink once; no symlinks within its artifact tree are followed.
    const directory = await realpath(join(resolve(runtimeRoot), 'node_modules', id));
    const metadata = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
    if (metadata.name !== id || (id.startsWith('@deepseek-ai/dsh-') && metadata.version !== '0.2.0-rc.2')) throw new Error('Published package/version mismatch');
    const info = { directory, metadata }; packages.set(id, info); return info;
  };
  const shellId = '@deepseek-ai/dsh-web-frontend', shell = await readPackage(shellId);
  const dist = join(shell.directory, 'dist');
  for (const path of await walk(dist)) await add(path, await readFile(await regularFile(dist, path)), shellId, shell.metadata.version);
  await add('graph.json', Buffer.from(JSON.stringify(inventory.graph)), '@deepseek-ai/dsh-client-modules', inventory.dshVersion);
  await add('boot-injections.json', Buffer.from(JSON.stringify(inventory.injections)), '@deepseek-ai/dsh-client-modules', inventory.dshVersion);
  const seenUrls = new Set();
  for (const resource of inventory.resources) {
    validateResourceUrl(resource.url);
    if (seenUrls.has(resource.url)) throw new Error('Duplicate inventory URL'); seenUrls.add(resource.url);
    if (!Array.isArray(resource.packages) || resource.packages.length === 0) throw new Error('Missing bundle provenance');
    const sources = [];
    for (const id of resource.packages) { const { metadata } = await readPackage(id); sources.push({ name: id, version: metadata.version }); }
    const bundle = await request(new URL('/api/web-control/native-ui/bundle', origin), { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: resource.url }) });
    if (!bundle.ok) throw new Error('Published client resource missing');
    const bytes = Buffer.from(await bundle.arrayBuffer());
    // A combo's query is part of its identity. The URL index preserves it while disk files remain portable.
    await add(`bundles/${hash(resource.url)}.js`, bytes, sources[0].name, sources[0].version, { url: resource.url, sources });
  }
  for (const [id, { directory, metadata }] of packages) {
    const license = (await readdir(directory)).find(name => /^(LICENSE|LICENSE\.md|LICENSE\.txt)$/i.test(name));
    if (!license) throw new Error(`Published license missing: ${id}`);
    const path = `licenses/${id.replaceAll('/', '__')}.txt`;
    await add(path, await readFile(await regularFile(directory, license)), id, metadata.version); manifest.licenses.push(path);
  }
  await verifyUiArtifacts(outputDir, manifest);
  await writeFile(join(outputDir, 'manifest.json'), JSON.stringify(manifest, null, 2), { flag: 'wx' });
  return manifest;
}
