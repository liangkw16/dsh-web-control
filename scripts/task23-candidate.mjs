/** Task23 builds Web/Relay only; retains reviewed compat5 and rollback archive bytes. */
import { execFileSync } from 'node:child_process'
import { mkdir, cp, readFile, writeFile, readdir } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import { createHash } from 'node:crypto'
const root = resolve('.'), directory = join(root, 'data/task23/candidate')
const hash = value => createHash('sha256').update(value).digest('hex')
const sourcePaths = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' }).trim().split('\n').filter(path => /^(packages\/.*\/(?:src\/.*\.(ts|tsx|css|sql)|package\.json|vite\.config\.ts|tsdown\.config\.ts|cordis\.patch\.yml)|package\.json|pnpm-lock\.yaml)$/.test(path)).sort()
const source = await Promise.all(sourcePaths.map(async path => ({ path, sha256: hash(await readFile(path)) })))
const sourceDigest = hash(source.map(({path, sha256}) => path + '\0' + sha256).join('\n'))
await mkdir(directory, { recursive: false })
const files = async (directory, prefix = '') => { const paths = []; for (const item of await readdir(directory, { withFileTypes: true })) { if (item.name === 'node_modules') continue; const path = prefix + item.name; if (item.isDirectory()) paths.push(...await files(join(directory, item.name), path + '/')); else if(item.isFile()) paths.push(path) } return paths.sort() }
const retained = []
for (const path of ['plugin', 'dsh-web-control-0.0.0-compat.5.tgz', 'dsh-web-control-0.0.0-compat.4.tgz']) {
  const from = join(root, 'data/task22/candidate', path), to = join(directory, path)
  await cp(from, to, { recursive: true, filter: input => !input.split('/').includes('node_modules') })
  const paths = path.endsWith('.tgz') ? [path] : (await files(from)).map(child => path + '/' + child)
  for (const relative of paths) { const previous = hash(await readFile(join(root, 'data/task22/candidate', relative))), current = hash(await readFile(join(directory, relative))); if (previous !== current) throw new Error('Retained bytes differ: ' + relative); retained.push({ path: relative, sha256: current, from: 'data/task22/candidate/' + relative }) }
}
for (const name of ['relay', 'web']) {
  await cp(join(root, 'packages', name, 'dist'), join(directory, name, ...(name === 'relay' ? ['dist'] : [])), { recursive: true })
  if (name === 'relay') await cp(join(root, 'packages/relay/package.json'), join(directory, 'relay/package.json'))
}
const built = await Promise.all((await files(directory)).filter(path => path.startsWith('web/') || path.startsWith('relay/')).map(async path => ({ path, sha256: hash(await readFile(join(directory, path))) })))
const artifactDigest = hash(built.map(({path, sha256}) => path + '\0' + sha256).join('\n'))
const manifest = { createdAt: new Date().toISOString(), base: 'df1026407e4350bce3e4bae2c388d8e30df75294', sourceDigest, source, artifactDigest, built, retained, note: 'Web/Relay rebuilt with bundled browser-only protocol additions; compat5 plugin and compat4 rollback retained byte-for-byte. Host wire unchanged.' }
await writeFile(join(directory, 'manifest.json'), JSON.stringify(manifest, null, 2))
await writeFile(join(directory, 'SHA256SUMS'), (await Promise.all((await files(directory)).map(async path => hash(await readFile(join(directory, path))) + '  ' + path))).join('\n') + '\n')
console.log(JSON.stringify({ directory, sourceDigest, artifactDigest, retained: retained.length }))
