import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, existsSync, lstatSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const value = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1] }
const local = args.includes('--local-candidate'), check = args.includes('--check')
const directory = resolve(value('--directory') ?? resolve(root, 'deploy'))
const platform = value('--platform') ?? 'linux/arm64'
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }).trim()
const registry = /^[a-z0-9][a-z0-9./:_-]*@sha256:[a-f0-9]{64}$/
function verifyRegistry(image) { if (!registry.test(image)) throw new Error('Registry image must contain a real repo@sha256 digest'); docker('buildx', 'imagetools', 'inspect', image); return image }
function official(tag) {
  const info = docker('buildx', 'imagetools', 'inspect', tag), digest = /^Digest:\s+(sha256:[a-f0-9]{64})$/m.exec(info)?.[1]
  if (!digest || !info.includes(`Platform:    ${platform}`)) throw new Error('Official image/platform could not be verified')
  return verifyRegistry(tag + '@' + digest)
}
function git(args) { try { return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() } catch { return undefined } }
function buildInputs() {
  const listing = git(['ls-files', '--cached', '--others', '--exclude-standard'])
  const files = listing === undefined ? JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')).buildSources : listing.split('\n')
  if (!Array.isArray(files)) throw new Error('Candidate manifest is missing build source inventory')
  const inputs = files.filter(path => /^(?:Dockerfile|\.dockerignore|package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.json)$/.test(path) || /^packages\/(plugin|relay|web|protocol)\/(src\/.*\.(ts|tsx|css|sql)|package\.json|tsdown\.config\.ts|vite\.config\.ts|build\.mjs|index\.html|cordis\.patch\.yml)$/.test(path)).sort()
  return { algorithm: 'sha256', digest: createHash('sha256').update(inputs.map(path => path + '\0' + createHash('sha256').update(readFileSync(resolve(root, path))).digest('hex')).join('\n')).digest('hex'), files: inputs.length }
}
if (check) {
  const env = Object.fromEntries(readFileSync(resolve(directory, '.env'), 'utf8').split('\n').filter(v => /^[A-Z_]+=/.test(v)).map(line => { const i = line.indexOf('='); return [line.slice(0, i), line.slice(i + 1)] }))
  const lock = JSON.parse(readFileSync(resolve(directory, 'images.lock.json'), 'utf8'))
  for (const [key, name] of [['NODE_IMAGE', 'node'], ['CADDY_IMAGE', 'caddy'], ['NGINX_IMAGE', 'nginx']]) if (env[key] !== lock.images[name]) throw new Error('Environment differs from image lock')
  if (env.RELAY_IMAGE !== lock.relay.reference || env.DEPLOY_MODE !== lock.mode) throw new Error('Relay identity/mode differs from image lock')
  if (lock.mode === 'local-candidate' && lock.buildInputs?.digest !== buildInputs().digest) throw new Error('Source differs from built image; rerun configure-deploy')
  if (!/^[1-9][0-9]*$/.test(env.RELAY_UID ?? '') || !/^[0-9]+$/.test(env.RELAY_GID ?? '')) throw new Error('Non-root relay UID/GID required')
  for (const key of ['NODE_IMAGE', 'CADDY_IMAGE', 'NGINX_IMAGE']) verifyRegistry(env[key] ?? '')
  if (env.DEPLOY_MODE === 'local-candidate' && local) {
    if (!/^sha256:[a-f0-9]{64}$/.test(env.RELAY_IMAGE ?? '')) throw new Error('Invalid immutable local image ID')
    if (docker('image', 'inspect', '--format', '{{.Id}}', env.RELAY_IMAGE) !== env.RELAY_IMAGE) throw new Error('Local image missing')
  } else verifyRegistry(env.RELAY_IMAGE ?? '')
  const secret = lstatSync(resolve(directory, 'secrets/enrollment'))
  if (!secret.isFile() || secret.isSymbolicLink()) throw new Error('Private secret must be a regular file')
  if ((secret.mode & 0o777) !== 0o600 || String(secret.uid) !== env.RELAY_UID || String(secret.gid) !== env.RELAY_GID) throw new Error('Private secret ownership does not match relay user')
  console.log('Deployment image pins and private secret ownership verified'); process.exit(0)
}
const uid = process.getuid(), gid = process.getgid()
if (uid === 0) throw new Error('Run setup as the non-root private secret owner')
const domain = value('--domain') ?? 'control.example.com'
if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(domain) || !domain.includes('.')) throw new Error('Domain required')
const images = { node: official('docker.io/library/node:24-bookworm-slim'), caddy: official('docker.io/library/caddy:2-alpine'), nginx: official('docker.io/library/nginx:stable-alpine') }
mkdirSync(directory, { recursive: true })
const provenance = { format: 1, mode: local ? 'local-candidate' : 'production', verifiedAt: new Date().toISOString(), platform, source: git(['rev-parse', 'HEAD']) ?? JSON.parse(readFileSync(resolve(root, 'manifest.json'), 'utf8')).source, dirty: !!git(['status', '--porcelain']), images }
provenance.buildInputs = buildInputs()
if (local) {
  const tag = 'dsh-web-control-task14-candidate:' + provenance.source.slice(0, 12)
  console.log('Building task-owned Linux relay candidate')
  execFileSync('docker', ['build', '--platform', platform, '--build-arg', 'NODE_IMAGE=' + images.node, '-t', tag, '.'], { cwd: root, stdio: 'inherit' })
  const metadata = JSON.parse(docker('image', 'inspect', tag))[0]
  provenance.relay = { reference: metadata.Id, kind: 'local-image-id', platform: metadata.Os + '/' + metadata.Architecture, repoDigests: metadata.RepoDigests ?? [], build: 'Dockerfile; frozen pnpm lock; target Linux dependencies' }
} else provenance.relay = { reference: verifyRegistry(value('--relay-image') ?? ''), kind: 'registry-digest' }
writeFileSync(resolve(directory, 'images.lock.json'), JSON.stringify(provenance, null, 2) + '\n')
writeFileSync(resolve(directory, '.env'), `CONTROL_DOMAIN=${domain}\nRELAY_IMAGE=${provenance.relay.reference}\nCADDY_IMAGE=${images.caddy}\nNODE_IMAGE=${images.node}\nNGINX_IMAGE=${images.nginx}\nRELAY_UID=${uid}\nRELAY_GID=${gid}\nDEPLOY_MODE=${provenance.mode}\n`, { mode: 0o600 })
const secrets = resolve(directory, 'secrets'); mkdirSync(secrets, { recursive: true, mode: 0o700 })
if (!existsSync(resolve(secrets, 'enrollment'))) execFileSync('docker', ['run', '--rm', '--network', 'none', '--read-only', '--user', `${uid}:${gid}`, '--mount', `type=bind,src=${secrets},dst=/secrets`, provenance.relay.reference, 'init', '--secret-file', '/secrets/enrollment'], { stdio: 'inherit' })
console.log('Configured ' + provenance.mode + '; credentials remain in private secret file')
