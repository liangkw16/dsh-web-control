/** Bind completed UI evidence to unchanged final product inputs and local candidate bytes. */
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createHash } from 'node:crypto';
const root = resolve('.'), candidate = join(root, 'data/task21/candidate');
const hash = value => createHash('sha256').update(value).digest('hex');
const manifest = JSON.parse(await readFile(join(candidate, 'manifest.json'), 'utf8'));
for (const file of manifest.source) if (hash(await readFile(join(root, file.path))) !== file.sha256) throw new Error('Product source changed: ' + file.path);
for (const file of [...manifest.web, ...manifest.retained, manifest.installedPlugin]) if (hash(await readFile(join(candidate, file.path))) !== file.sha256) throw new Error('Candidate changed: ' + file.path);
for (const file of manifest.web) if (hash(await readFile(join(root, 'packages/web/dist', file.path.slice(4)))) !== file.sha256) throw new Error('Tested Web differs: ' + file.path);
for (const file of manifest.retained) if (hash(await readFile(join(root, file.from))) !== file.sha256) throw new Error('Retained provenance differs: ' + file.path);
const native = JSON.parse(await readFile(join(root, 'data/task21/native-YUgF8x/evidence.json'), 'utf8'));
if(native.webDigest !== manifest.webDigest || native.sourceDigest !== manifest.sourceDigest || native.status !== 'PASS') throw new Error('Native evidence binding failed');
const inputs = ['scripts/task21-native.mjs','scripts/task21-check.mjs','scripts/task21-candidate.mjs','scripts/task21-verify.mjs','tests/e2e/workspace-design.spec.ts','tests/e2e/core-flows.spec.ts','tests/e2e/mobile-layout.spec.ts','tests/e2e/reconnect.spec.ts','tests/e2e/preview-isolation.spec.ts','tests/e2e/fixtures.ts','packages/web/tests/markdown.test.tsx'];
const verificationInputs = await Promise.all(inputs.map(async path => ({ path, sha256: hash(await readFile(path)) })));
const result = { checkedAt: new Date().toISOString(), argv: process.argv, pid: process.pid, sourceDigest: manifest.sourceDigest, webDigest: manifest.webDigest, sourceFiles: manifest.source.length, webFiles: manifest.web.length, retainedFiles: manifest.retained.length, nativeBound: true, verificationInputs };
await writeFile(join(root, 'data/task21/final-binding.json'), JSON.stringify(result, null, 2)); console.log(JSON.stringify(result));
