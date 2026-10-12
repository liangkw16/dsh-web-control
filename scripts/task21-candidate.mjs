/** Build-input snapshot and immutable local candidate assembly; retained artifacts are copied, never rebuilt. */
import { execFileSync } from 'node:child_process';
import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve('.'), directory = join(root, 'data/task21/candidate');
const hash = value => createHash('sha256').update(value).digest('hex');
const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n').filter(path => /^(packages\/.*\/(?:src\/.*\.(ts|tsx|css|sql)|package\.json|vite\.config\.ts|tsdown\.config\.ts|cordis\.patch\.yml)|package\.json|pnpm-lock\.yaml)$/.test(path)).sort();
const source = await Promise.all(sourcePaths.map(async path => ({ path, sha256: hash(await readFile(path)) })));
const sourceDigest = hash(source.map(({path, sha256}) => path + '\0' + sha256).join('\n'));
await mkdir(directory, { recursive: false });
await writeFile(join(root, 'data/task21/source-inputs.json'), JSON.stringify({ capturedAt: new Date().toISOString(), base: 'f6ea216db4ef0981a27f99914fb9d6783d782801', sourceDigest, source }, null, 2));
const files = async (directory, prefix = '') => { const paths = []; for (const item of await readdir(directory, { withFileTypes: true })) { if (item.name === 'node_modules') continue; const path = prefix + item.name; if (item.isDirectory()) paths.push(...await files(join(directory, item.name), path + '/')); else if(item.isFile()) paths.push(path) } return paths.sort() };
const retained = [];
for (const path of ['plugin', 'relay', 'dsh-web-control-0.0.0-compat.4.tgz']) {
  const from = join(root, 'data/task20/candidate', path), to = join(directory, path);
  await cp(from, to, { recursive: true, filter: input => !input.split('/').includes('node_modules') });
  const paths = path.endsWith('.tgz') ? [path] : (await files(from)).map(child => path + '/' + child);
  for (const relative of paths) { const previous = hash(await readFile(join(root, 'data/task20/candidate', relative))), current = hash(await readFile(join(directory, relative))); if (previous !== current) throw new Error('Retained bytes differ: ' + relative); retained.push({ path: relative, sha256: current, from: 'data/task20/candidate/' + relative }) }
}
await cp(join(root, 'data/task19/candidate/dsh-web-control-0.0.0-compat.3.tgz'), join(directory, 'dsh-web-control-0.0.0-compat.3.tgz'));
const installedPlugin = { path: 'dsh-web-control-0.0.0-compat.3.tgz', sha256: hash(await readFile(join(directory, 'dsh-web-control-0.0.0-compat.3.tgz'))), from: 'data/task19/candidate/dsh-web-control-0.0.0-compat.3.tgz' };
if (installedPlugin.sha256 !== '1a9f8452a349b5c7dc6b74d4117e640e1f53f00b539ef0a6cec1a3c6ed1a476b') throw new Error('plugin3 archive mismatch');
await cp(join(root, 'packages/web/dist'), join(directory, 'web'), { recursive: true });
const web = await Promise.all((await files(join(directory, 'web'))).map(async path => ({ path: 'web/' + path, sha256: hash(await readFile(join(directory, 'web', path))) })));
const webDigest = hash(web.map(({path, sha256}) => path + '\0' + sha256).join('\n'));
const manifest = { createdAt: new Date().toISOString(), sourceDigest, source, webDigest, web, retained, installedPlugin, note: 'Web rebuilt only. Task20 plugin4 and Relay preserved byte-for-byte; installed-compatible plugin3 copied solely for owned native smoke.' };
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2));
const sums = await Promise.all((await files(directory)).map(async path => hash(await readFile(join(directory, path))) + '  ' + path)); await writeFile(join(directory, 'SHA256SUMS'), sums.join('\n') + '\n');
console.log(JSON.stringify({ directory, sourceDigest, webDigest, retained: retained.length }));
