import { readFile, writeFile, mkdir } from 'node:fs/promises'
import { resolve, dirname } from 'node:path'
import { createHash } from 'node:crypto'
import { candidateIdentity, validateReceipt, safeErrorMessage } from './acceptance-evidence.mjs'
export const required = ['stock-web', 'stock-desktop', 'ios-cellular', 'android-cellular', 'pc-browsers', 'restarts', 'revocation', 'deploy-restore', 'public-relay', 'registry-release', 'performance', 'pc-browser-versions', 'released-version-lifecycle']
export const checks = ['typecheck', 'test', 'test:system', 'playwright', 'test:deploy', 'check:package']
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const exact = (value, keys) => record(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key))
const nonempty = value => typeof value === 'string' && value.trim().length > 0
const date = value => typeof value === 'string' && /^\d{4}-\d\d-\d\dT/.test(value) && Number.isFinite(Date.parse(value))
const diagnosticNames = new Set([...required, ...checks, 'bounded-upload-stress', 'pc-engine-matrix', 'pc-scoped-performance', 'native-file-read-failclosed', 'stock-web-original-session-unload', 'candidate-image-forward-backward', 'performance', 'older-page-covering', 'color-covering', 'validator-fix'])
const diagnosticName = name => diagnosticNames.has(name) ? name : 'unknown'
export async function validateReport(report, base = process.cwd()) {
  const failures = []
  if (!exact(report, ['cases', 'generatedAt', 'versions', 'environment', 'source', 'checks', 'artifacts'])) return ['invalid report schema']
  if (!date(report.generatedAt) || !nonempty(report.environment) || !/^[a-f0-9]{40}$/.test(report.source ?? '') || !record(report.versions) || !Object.values(report.versions).every(nonempty) || !['projectNode', 'stockNode', 'dsh', 'plugin', 'relay', 'web'].every(key => nonempty(report.versions[key]))) failures.push('missing provenance')
  let identity
  try { identity = await candidateIdentity(report, base) } catch (error) { failures.push('invalid candidate provenance: ' + safeErrorMessage(error)) }
  const receipts = new Map()
  if (!record(report.cases)) failures.push('invalid cases')
  else {
    for (const [name, item] of Object.entries(report.cases)) {
      if (!exact(item, ['status', 'evidence']) || !['PASS', 'FAIL', 'NOT_RUN'].includes(item.status) || !nonempty(item.evidence)) { failures.push(`invalid case: ${name}`); continue }
      // PASS references an actual compatibility/evidence file; NOT_RUN explains its missing condition.
      if (item.status === 'PASS') { try { receipts.set('case:' + name, await validateReceipt(item.evidence, 'case', name, report, identity, base)) } catch (error) { failures.push(`invalid case evidence: ${diagnosticName(name)}: ${safeErrorMessage(error)}`) } }
    }
    for (const name of required) if (report.cases[name]?.status !== 'PASS') failures.push(`required gate: ${name} ${report.cases[name]?.status ?? 'MISSING'}`)
  }
  if (!Array.isArray(report.checks)) failures.push('invalid checks')
  else {
    const names = new Set()
    for (const item of report.checks) {
      if (!exact(item, ['name', 'command', 'startedAt', 'finishedAt', 'exitCode', 'log', 'receipt']) || !nonempty(item.name) || !nonempty(item.command) || !nonempty(item.log) || !date(item.startedAt) || !date(item.finishedAt) || Date.parse(item.finishedAt) < Date.parse(item.startedAt) || !Number.isInteger(item.exitCode) || item.exitCode < 0 || item.exitCode > 255 || names.has(item.name)) { failures.push('invalid check record'); continue }
      names.add(item.name)
      if (item.exitCode !== 0) failures.push(`test exit: ${item.name} ${item.exitCode}`)
      try { receipts.set(item.name, await validateReceipt(item.receipt, 'check', item.name, report, identity, base, item)) } catch (error) { failures.push(`invalid check evidence: ${diagnosticName(item.name)}: ${safeErrorMessage(error)}`) }
    }
    for (const name of checks) if (!names.has(name)) failures.push(`missing test exit: ${name}`)
  }
  if (!Array.isArray(report.artifacts) || report.artifacts.length < 3) failures.push('missing release checksums')
  else {
    const paths = new Set()
    for (const item of report.artifacts) {
      if (!exact(item, ['path', 'sha256']) || !nonempty(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256 ?? '') || paths.has(item.path)) { failures.push('invalid artifact'); continue }
      paths.add(item.path)
      try { if (createHash('sha256').update(await readFile(resolve(base, item.path))).digest('hex') !== item.sha256) failures.push(`checksum mismatch: ${item.path}`) } catch { failures.push(`missing artifact: ${item.path}`) }
    }
    if (!report.artifacts.some(item => /dsh-web-control-0.*\.tgz$/.test(item.path)) || !report.artifacts.some(item => /dsh-web-control-relay-.*\.tgz$/.test(item.path)) || !report.artifacts.some(item => /images\.lock\.json$/.test(item.path))) failures.push('missing intended plugin/relay/image metadata checksums')
  }
  for (const [name, receipt] of receipts) for (const dependency of receipt.coveredBy) if (!receipts.has(dependency)) failures.push(`missing validated scoped coverage: ${name} -> ${dependency}`)
  if (receipts.has('case:stock-web')) { const latest = Math.max(...[...receipts.values()].map(r => Date.parse(r.finishedAt))); if (Date.parse(report.generatedAt) < latest || Date.parse(report.generatedAt) > Date.now() + 60000) failures.push('invalid aggregate chronology') }
  return failures
}
// Explanatory rows follow validated raw records, never stale hand-authored version prose.
export async function currentEvidenceProse(report, base = process.cwd()) {
  const prose = {}
  if (!report) return prose
  let identity
  try { identity = await candidateIdentity(report, base) } catch { return prose }
  for (const [name, target] of [['pc-engine-matrix', 'pc-browser-versions'], ['candidate-image-forward-backward', 'released-version-lifecycle']]) {
    const item = report.cases?.[name]
    if (item?.status !== 'PASS') continue
    try {
      const receipt = await validateReceipt(item.evidence, 'case', name, report, identity, base)
      if (name === 'pc-engine-matrix') {
        const records = await Promise.all(receipt.files.filter(file => file.role === 'browser-version').map(async file => JSON.parse(await readFile(resolve(base, file.path), 'utf8'))))
        const observed = Object.fromEntries(records.map(record => [record.engine, record.version]))
        prose[target] = `Observed Chrome ${observed.chromium}, Firefox ${observed.firefox}, managed WebKit ${observed.webkit}; previous majors and actual stable Edge/Safari remain NOT_RUN.`
      } else {
        const file = receipt.files.find(file => file.role === 'deploy')
        const lines = (await readFile(resolve(base, file.path), 'utf8')).split('\n')
        const swap = lines.filter(line => line.startsWith('{')).map(line => { try { return JSON.parse(line) } catch { return {} } }).find(record => record.phase === 'candidate-image-forward-backward')
        prose[target] = `Recorded same-schema candidate image swap ${swap.previousImage.slice(7,14)}… ↔ ${swap.currentImage.slice(7,14)}… passed; actual released plugin/version upgrade and rollback remain NOT_RUN.`
      }
    } catch { /* Invalid evidence never supplies an observed/current claim. */ }
  }
  return prose
}
export async function main(args = process.argv.slice(2)) {
  try { return await runMain(args) } catch {
    console.log(JSON.stringify({ status: 'FAIL', failures: ['acceptance processing failed'] }))
    return 1
  }
}
async function runMain(args) {
  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  const output = resolve(option('--report') ?? 'docs/acceptance-report.md'), input = resolve(option('--input') ?? 'data/task15/acceptance-input.json')
  let report, failures
  try { report = JSON.parse(await readFile(input, 'utf8')); failures = await validateReport(report) } catch { failures = ['acceptance input missing or invalid JSON'] }
  const lines = ['# Final acceptance — local candidate', '', `Generated: ${new Date().toISOString()}. Aggregate: **${failures.length ? 'FAIL (exit 1)' : 'PASS'}**.`, '', 'A PASS requires typed case-specific receipts, matching raw evidence bytes, actual run-ledger command/exit/chronology, bounded historical coverage and current candidate content/artifact identity. NOT_RUN fails release. Desktop/public/physical evidence cannot be inferred from automation. Fixed v1 policy defers live current-file preview/download; uploads and authorized recorded historical diff remain in scope.', '', '| Required case | Status | Evidence / limitation |', '| --- | --- | --- |']
  const prose = await currentEvidenceProse(report)
  for (const name of required) { const item = report?.cases?.[name]; lines.push(`| ${name} | ${item?.status ?? 'NOT_RUN'} | ${String(prose[name] ?? item?.evidence ?? 'Missing evidence').replaceAll('|', '\\|').replaceAll('\n', ' ')} |`) }
  if (report) lines.push('', 'Provenance and actual command results:', '', '```json', JSON.stringify({ generatedAt: report.generatedAt, versions: report.versions, environment: report.environment, source: report.source, evidencePolicy: 'Typed byte-bound receipts; historical scope never implies a final-tree whole-suite run', checks: report.checks, artifacts: report.artifacts }, null, 2), '```')
  if (failures.length) lines.push('', 'Gate failures:', '', ...failures.map(reason => '- ' + reason))
  lines.push('', `Evidence is external to this candidate: use --input ${input.replace(process.cwd() + '/', '')} from the repository evidence root. All relative receipt/raw/artifact paths resolve against the current working directory, not the input file directory. The candidate does not carry historical machine proof. Missing evidence fails; the unchanged rc.2 gates without approved case-specific validators cannot be promoted to PASS by a generic document or receipt.`, '')
  lines.push('', 'Release remains BLOCKED by untested required gates. The user approved deferring live current-file preview/download from v1. Uploads and authorized recorded historical diff remain; file.read continues PROTOCOL_UNSUPPORTED with zero binary output. This fixed policy removes only current-file-preview from required v1 gates; caller statuses cannot exempt any other gate. Only the local candidate is delivered.', '')
  await mkdir(dirname(output), { recursive: true }); await writeFile(output, lines.join('\n'))
  console.log(JSON.stringify({ status: failures.length ? 'FAIL' : 'PASS', failures, report: output }))
  return failures.length ? 1 : 0
}
if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) process.exitCode = await main()
