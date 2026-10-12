/** Local machine receipts: byte integrity + typed results, not signatures or release authorization. */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { createHash } from 'node:crypto'
export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex')
export const exact = (v, keys) => v !== null && typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === keys.length && keys.every(k => Object.hasOwn(v, k))
const safePath = value => typeof value === 'string' && value.length > 0 && !value.startsWith('/') && !value.split('/').includes('..')
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b)
class SafeValidationError extends Error {}
export const safeErrorMessage = error => error instanceof SafeValidationError ? error.message : 'unexpected evidence error'
const need = (value, message) => { if (!value) throw new SafeValidationError(message) }
async function readEvidence(path, context) {
  try { return await readFile(path) } catch { throw new SafeValidationError(context + ' unavailable') }
}
function parseEvidence(bytes, context) {
  try { return JSON.parse(bytes) } catch { throw new SafeValidationError(context + ' invalid JSON') }
}
const rawRoles = new Set(['native','classic','invocation','run-ledger','run-log','log','stress','results','scope-inputs','source-snapshot','deploy','browser','browser-version','metrics','public-trial','deployment','deployment-source','deployment-observed'])
const rawContext = role => 'raw role ' + (rawRoles.has(role) ? role : 'unknown')
const readableLog = text => text.replace(/\u001b\[[0-9;]*m/g, '')
const jsonLines = text => text.split('\n').filter(v => v.startsWith('{')).map(v => { try { return JSON.parse(v) } catch { return null } }).filter(Boolean)
export const nativeRequired = ['pinned-public-runtime', 'one-public-core-runtime', 'final-ui-same-local-session', 'final-ui-real-relay-native-controls', 'final-ui-native-cleanup', 'final-ui-one-public-core-runtime']
export const publicRequired = ['pinned-public-runtime','public-runtime-tarball-sri','unchanged-packed-plugin','normal-trust-public-https','public-cli-install','stock-startup-disabled','same-public-origin','native-fixture-ready','same-original-native-session','one-active-controller','public-wss-reconnect','uploaded-prompt-same-session','native-ui-console-clean','native-two-turns','native-fixture-cleanup','single-public-core-runtime','normal-trust-public-wss','owned-instance-disabled','owned-instance-revoked']
export const lifecycleRequired = ['actual-provider-Web-restart-link-persistence', 'remove-reinstall-retains-authorized-identity', 'rotation-ACK-new-link', 'old-link-rejected-after-rotate', 'stop-durable-disabled', 'stopped-link-rejected', 'stopped-restart-remains-disabled']
export const coverage = {
  test: ['validator-fix', 'typecheck', 'performance', 'older-page-covering', 'color-covering', 'case:stock-web'],
  'test:system': ['color-covering', 'performance', 'older-page-covering', 'case:stock-web'],
  playwright: ['performance', 'older-page-covering'],
}
// Required production browser behaviors; fresh runs may add cases but cannot omit these.
export const freshBrowserCases = [
  {
    "file": "core-flows.spec.ts",
    "title": "switch, draft, prompt, stop and create use real Host commands"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "approval and choice/multiple/text question settle globally via accepted answer"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "Host cancellation leaves a read-only handled card"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "copied lease in second tab is busy without takeover"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "refresh preserves selection and independent authorization cookie"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "offline retains history and draft and cannot claim send success"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "upload durable receipt becomes prompt content and recorded diff opens"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "current file capability is honest and detail navigation returns"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "older page keeps visible anchor and new content waits while reading"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "uncertain submit only checks the outcome with the same request ID"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "accepted captured draft does not erase typing while awaiting reply"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "answer uncertainty is read-only and never automatically replayed; stale stop is explained"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "background tab return and session sync stay disabled until follow baseline arrives"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "attachment progress, failure reselect and uncertain acceptance retain correct ownership"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "public assistant live chunks are replaced by one durable message"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "outcome check settles original attachments even after switching session"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "deferred file details discard session and navigation completions"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "answer uncertain retains read-only authority across card remount"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "answer in-flight retains read-only authority across card remount"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "multiple unresolved prompts retain independent checks and attachment ownership"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "unresolved prompt capacity refuses fresh sends without evicting checks"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "removed selected session retires controls and another valid selection remains usable"
  },
  {
    "file": "core-flows.spec.ts",
    "title": "fragmented live prose and code preserve newlines through durable replacement"
  },
  {
    "file": "mobile-layout.spec.ts",
    "title": "composition enter does not send"
  },
  {
    "file": "mobile-layout.spec.ts",
    "title": "360px conversation has no page overflow and drawer returns"
  },
  {
    "file": "mobile-layout.spec.ts",
    "title": "long tool result scrolls locally at 360px and detail back restores input"
  },
  {
    "file": "mobile-layout.spec.ts",
    "title": "Shift Enter, viewport keyboard resize and orientation keep composer in view"
  },
  {
    "file": "preview-isolation.spec.ts",
    "title": "actual FilePreview escapes active HTML in empty sandbox under delivered CSP"
  },
  {
    "file": "preview-isolation.spec.ts",
    "title": "raster Blob preview is bounded and URLs revoke on unmount; download is attachment"
  },
  {
    "file": "preview-isolation.spec.ts",
    "title": "public diff unsupported and coarse states are explicit"
  },
  {
    "file": "reconnect.spec.ts",
    "title": "offline page keeps draft and reconnect synchronizes before new submission"
  }
]
export const freshScope = 'fresh source snapshot captured in the actual run ledger before execution'
const historicalCandidate = {
  source: '4b067e3105963cb5d5f7e7b2fe1f79fafddd15d0',
  digest: '37cd866b0a76e53a853dde25893d3a629265e69745bc6110605646771983d467',
  plugin: '04211b9c6383e6b12b798c5eb0d0b51459373c5603472da0e9623063bf3fd0ba',
  relay: '10b08ff790f88b270ddee1940408eb4966d4c4bf7dfdfa6febe228d353907800',
  image: 'sha256:913f833144ce52d565ede5bd599df07ae555a6084a64e05a5b7bb0b9da8f2a5f',
}
function historicalBinding(identity) {
  need(identity.source === historicalCandidate.source && identity.buildInputs.digest === historicalCandidate.digest && identity.pluginSha256 === historicalCandidate.plugin && identity.relaySha256 === historicalCandidate.relay && identity.imageReference === historicalCandidate.image, 'historical coverage applies only to the recorded Task15 candidate')
}
export function scopeFor(kind, name) {
  if (kind === 'case') return 'recorded case-specific integration; candidate content binding is checked against retained native/image evidence'
  if (coverage[name]) return `historical ${name}; original full-run source fingerprint was not captured; later scoped coverage required, not a final-tree full-suite claim`
  return 'recorded scoped check; no claim of a later whole-suite execution'
}
export async function candidateIdentity(report, base) {
  const artifacts = new Map(report.artifacts.map(a => [a.path.split('/').at(-1), a]))
  const plugin = artifacts.get(`dsh-web-control-${report.versions.plugin}.tgz`), relay = artifacts.get(`dsh-web-control-relay-${report.versions.relay}.tgz`), image = artifacts.get('images.lock.json')
  need(plugin && relay && image, 'intended versioned artifacts missing')
  const lock = parseEvidence(await readEvidence(resolve(base, image.path), 'candidate image lock'), 'candidate image lock')
  const manifest = parseEvidence(await readEvidence(resolve(base, 'dist/release/manifest.json'), 'candidate manifest'), 'candidate manifest')
  need(lock.source === report.source && manifest.images.source === lock.source && manifest.dirty === true, 'candidate source provenance mismatch')
  need(lock.mode === 'local-candidate' && lock.dirty === true && /^[a-f0-9]{40}$/.test(lock.source) && !/^0+$/.test(lock.source), 'invalid local candidate provenance')
  need(eq(manifest.images, lock) && manifest.releaseStatus === 'BLOCKED', 'candidate lock/manifest mismatch')
  need(Array.isArray(manifest.buildSources) && new Set(manifest.buildSources).size === manifest.buildSources.length, 'invalid build inventory')
  const inputs = []
  for (const path of manifest.buildSources) {
    need(typeof path === 'string' && !path.startsWith('/') && !path.split('/').includes('..'), 'invalid source path')
    const current = await readEvidence(resolve(base, path), 'candidate source'), bundled = await readEvidence(resolve(base, 'dist/release', path), 'bundled candidate source')
    need(sha256(current) === sha256(bundled), 'candidate source bytes differ')
    inputs.push(path + '\0' + sha256(current))
  }
  need(sha256(inputs.join('\n')) === lock.buildInputs.digest && inputs.length === lock.buildInputs.files, 'candidate content fingerprint mismatch')
  for (const name of ['plugin', 'relay', 'web']) {
    const pkg = parseEvidence(await readEvidence(resolve(base, `packages/${name}/package.json`), 'candidate package ' + name), 'candidate package ' + name)
    need(pkg.version === report.versions[name] && manifest.versions[name] === pkg.version, 'candidate version mismatch: ' + name)
    if (name === 'plugin') need(pkg.peerDependencies['@deepseek-ai/dsh'] === report.versions.dsh, 'DSH version mismatch')
  }
  need(report.versions.projectNode === 'v24.18.1' && report.versions.stockNode === 'v26.8.2' && report.versions.dsh === '0.2.0-rc.2', 'unvalidated runtime versions')
  return { source: lock.source, dirty: lock.dirty, buildInputs: lock.buildInputs, pluginSha256: plugin.sha256, relaySha256: relay.sha256, imageLockSha256: image.sha256, imageReference: lock.relay.reference }
}
const file = (files, role) => { const found = files.filter(f => f.role === role); need(found.length === 1, 'missing/duplicate raw role: ' + role); return found[0] }
function validateNative(raw, receipt, identity, versions, fresh = false) {
  need(raw.status === 'PASS' && raw.pluginSha256 === identity.pluginSha256 && raw.source === identity.source && raw.dirty === identity.dirty && eq(raw.buildInputs, identity.buildInputs), 'native artifact/result mismatch')
  need(raw.projectNode === versions.projectNode && raw.stockNode === versions.stockNode && raw.releaseIntegrity === 'sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==', 'native runtime mismatch')
  need((fresh ? Date.parse(raw.startedAt) >= Date.parse(receipt.startedAt) && Date.parse(raw.finishedAt) <= Date.parse(receipt.finishedAt) : raw.startedAt === receipt.startedAt && raw.finishedAt === receipt.finishedAt) && receipt.environment.startsWith(raw.environment + ';'), 'native chronology/environment mismatch')
  need(raw.checks.every(c => c.ok === true) && raw.processes.length >= 2 && raw.processes.every(p => p.exitCode === 0 && p.signal === null) && raw.ephemeralTLSAndEnrollmentRemoved === true, 'native incomplete/failed cleanup')
  const names = new Set(raw.checks.filter(c => c.ok).map(c => c.name))
  for (const name of nativeRequired) need(names.has(name), 'native required result missing: ' + name)
  need(raw.browser.version === (fresh ? versions.chromium : '154.0.8037.98') && eq(raw.viewports.map(v => v.width), [360,390,768,1280]) && raw.viewports.every(v => v.noOverflow === true), 'native browser/viewport mismatch')
  need(raw.nativeUI.starts === 2 && raw.nativeUI.approvals === 2 && raw.nativeUI.stops === 2 && raw.nativeUICleanup.clean && raw.nativeUICleanup.pendingModelStreams === 0, 'native operation result incomplete')
  return names
}
function validateDeploy(text, identity) {
  const lines = jsonLines(text), phase = name => lines.find(l => l.phase === name)
  need(phase('https-wss-ready') && lines.some(l => l.phase === 'https-wss-ready' && l.gateway === 'nginx'), 'gateway evidence incomplete')
  need(phase('restart-backup-restore-passed') && phase('offline-enrollment-rotation-recreated') && phase('exact-project-cleanup') && text.includes('Isolated deployment smoke PASS'), 'deploy outcome incomplete')
  const replacement = phase('candidate-image-forward-backward')
  need(replacement && replacement.currentImage === identity.imageReference, 'candidate replacement identity mismatch')
  need(!/Isolated deployment smoke FAIL/.test(text), 'deploy failed')
}
function testsPassed(text, count, skipped = 0) {
  need(Number.isInteger(count) && count > 0, 'invalid passed count')
  const unit = new RegExp(`Tests\\s+${count} passed${skipped ? ' \\| ' + skipped + ' skipped' : ''} \\(${count + skipped}\\)`)
  const browser = new RegExp(`(?:^|\\n)\\s+${count} passed \\([0-9.]+[sm]\\)`)
  need(unit.test(text) || (!skipped && browser.test(text)), 'successful complete test summary missing')
  need(!/\b(?:[1-9][0-9]* failed|FAIL(?:ED)?\b)/.test(text), 'failed test evidence')
}
function fullUnitCount(text) { const match = /Tests\s+([0-9]+) passed \(([0-9]+)\)/.exec(text); need(match && match[1] === match[2], 'incomplete full unit summary'); return Number(match[1]) }
function fullBrowserCount(text) { return Number(/(?:^|\n)\s+([0-9]+) passed \([0-9.]+[sm]\)/.exec(text)?.[1]) }

export async function validateReceipt(path, kind, name, report, identity, base, check) {
  need(safePath(path), 'unsafe receipt path')
  const receipt = parseEvidence(await readEvidence(resolve(base, path), 'receipt'), 'receipt')
  need(exact(receipt, ['format', 'kind', 'name', 'outcome', 'startedAt', 'finishedAt', 'versions', 'environment', 'candidateUnderReview', 'scope', 'coveredBy', 'files', 'result']), 'invalid typed receipt schema')
  need(receipt.format === 1 && receipt.kind === kind && receipt.name === name && receipt.outcome === 'PASS', 'wrong scope or failed receipt')
  need(eq(receipt.versions, report.versions) && receipt.environment === report.environment && eq(receipt.candidateUnderReview, identity), 'receipt candidate/version/environment mismatch')
  const fresh = receipt.scope === freshScope
  need((fresh || receipt.scope === scopeFor(kind, name)) && eq(receipt.coveredBy, fresh ? [] : coverage[name] ?? []), 'unapproved retrospective coverage')
  need(Number.isFinite(Date.parse(receipt.startedAt)) && Date.parse(receipt.startedAt) <= Date.parse(receipt.finishedAt) && Date.parse(receipt.finishedAt) <= Date.parse(report.generatedAt), 'receipt chronology mismatch')
  need(Array.isArray(receipt.files) && receipt.files.length > 0, 'raw evidence missing')
  const files = []
  for (const f of receipt.files) { need(exact(f, ['role', 'path', 'sha256']) && safePath(f.path) && /^[a-f0-9]{64}$/.test(f.sha256), 'invalid raw file binding'); const bytes = await readEvidence(resolve(base, f.path), rawContext(f.role)); need(sha256(bytes) === f.sha256, 'raw evidence checksum mismatch'); files.push({ ...f, text: readableLog(bytes.toString()), json: () => parseEvidence(bytes, rawContext(f.role)) }) }
  const raw = role => file(files, role)
  if (!fresh && ((kind === 'check' && coverage[name]) || ['bounded-upload-stress','pc-engine-matrix','pc-scoped-performance'].includes(name))) historicalBinding(identity)
  const caseRun = { 'deploy-restore':'test:deploy', 'candidate-image-forward-backward':'test:deploy', 'bounded-upload-stress':'test:system', 'pc-engine-matrix':'playwright', 'pc-scoped-performance':'performance', ...(fresh ? { 'stock-web':'native', 'restarts':'native', 'revocation':'native', 'native-file-read-failclosed':'native', 'stock-web-original-session-unload':'classic', 'public-relay':'public-trial' } : {}) }[name]
  if (kind === 'case' && caseRun) {
    const entries = raw('run-ledger').json().filter(e => e.name === caseRun)
    need(entries.length === 1 && receipt.result.command === entries[0].command && receipt.result.exitCode === entries[0].exitCode && entries[0].exitCode === 0 && entries[0].startedAt === receipt.startedAt && entries[0].finishedAt === receipt.finishedAt, 'case run chronology/outcome mismatch')
    need(files.some(f => f.path === entries[0].log), 'case result not bound to actual run log')
  }
  if (fresh) {
    const snapshot = raw('source-snapshot').json(), entryName = kind === 'check' ? name : caseRun
    const entry = raw('run-ledger').json().find(e=>e.name===entryName)
    need(entry && entry.sourceSnapshotSha256 === raw('source-snapshot').sha256 && exact(snapshot, ['capturedAt','buildInputs','files']) && eq(snapshot.buildInputs, identity.buildInputs), 'fresh source capture missing from actual ledger')
    need(Date.parse(snapshot.capturedAt) <= Date.parse(receipt.startedAt) && Date.parse(receipt.startedAt)-Date.parse(snapshot.capturedAt) <= 60000, 'source snapshot not captured before this run')
    const manifest = parseEvidence(await readEvidence(resolve(base,'dist/release/manifest.json'), 'candidate manifest'), 'candidate manifest')
    need(Array.isArray(snapshot.files) && manifest.buildSources.every(path=>snapshot.files.some(f=>f.path===path)), 'fresh snapshot incomplete')
    for (const input of snapshot.files) need(safePath(input.path) && sha256(await readEvidence(resolve(base,input.path), 'fresh tested source'))===input.sha256, 'fresh tested source changed')
  }
  if (fresh && ['playwright','performance','pc-engine-matrix','pc-scoped-performance','stock-web','restarts','revocation','native-file-read-failclosed'].includes(name)) {
    const engines = ['chromium','firefox','webkit']
    for (const engine of engines) need(typeof report.versions[engine] === 'string' && /^[0-9]{1,4}(?:\.[0-9]{1,6}){1,3}$/.test(report.versions[engine]), 'invalid declared fresh engine version')
    const observed = files.filter(f => f.role === 'browser-version').map(f => f.json()).sort((a,b) => String(a.engine).localeCompare(String(b.engine)))
    need(eq(observed.map(v => [v.engine,v.version,v.physicalPhone]), engines.map(engine => [engine,report.versions[engine],false])), 'fresh declared engine tuple differs from captured records')
  }
  if (fresh && (name === 'playwright' || name === 'pc-engine-matrix')) {
    const results = raw('results').json(), log = raw(kind === 'check' ? 'log' : 'browser').text
    need(results.stats && results.stats.unexpected === 0 && results.stats.skipped === 0 && results.stats.flaky === 0 && results.stats.expected === fullBrowserCount(log), 'fresh browser result/count mismatch')
    const specs = []; const visit = suite => { for (const spec of suite.specs ?? []) specs.push(spec); for (const child of suite.suites ?? []) visit(child) }; for (const suite of results.suites ?? []) visit(suite)
    const manifest = raw('scope-inputs').json()
    const entry = raw('run-ledger').json().find(item => item.name === (kind === 'check' ? name : caseRun))
    need(entry.scopeInputsSha256 === raw('scope-inputs').sha256, 'fresh browser inventory not bound before run')
    need(exact(manifest, ['cases']) && Array.isArray(manifest.cases) && manifest.cases.length > 0, 'fresh browser case inventory missing')
    const actual = specs.flatMap(spec => spec.tests.map(test => ({ file: spec.file, title: spec.title, project: test.projectName, ok: test.status === 'expected' && test.results.length > 0 && test.results.every(result => result.status === 'passed') })))
    need(actual.length === manifest.cases.length && actual.every(item => item.ok) && manifest.cases.every(item => exact(item, ['file','title','project']) && actual.some(found => found.file === item.file && found.title === item.title && found.project === item.project)), 'fresh browser case inventory mismatch')
    for (const engine of ['chromium','firefox','webkit']) for (const expected of freshBrowserCases) need(actual.some(item => item.project === engine && item.file === expected.file && item.title === expected.title), 'fresh browser required scope missing')
    need(Date.parse(results.stats.startTime) >= Date.parse(receipt.startedAt) && Date.parse(results.stats.startTime)+results.stats.duration <= Date.parse(receipt.finishedAt)+1000, 'fresh browser chronology mismatch')
  }
  if (kind === 'check') {
    need(exact(receipt.result, ['command', 'exitCode']) && receipt.result.exitCode === 0, 'failed check receipt')
    need(receipt.result.command === check.command && check.exitCode === 0 && receipt.startedAt === check.startedAt && receipt.finishedAt === check.finishedAt, 'check command/exit/chronology mismatch')
    const ledger = raw('run-ledger').json(); const entries = ledger.filter(e => e.name === name)
    need(entries.length === 1 && entries[0].command === check.command && entries[0].startedAt === check.startedAt && entries[0].finishedAt === check.finishedAt && entries[0].exitCode === 0 && entries[0].log === check.log, 'actual run ledger mismatch')
    need(raw('log').path === check.log && check.command.includes('node24/node_modules/node-bin-darwin-arm64/bin/node') && check.command.includes('pnpm.mjs'), 'wrong command/runtime/log')
    const text = raw('log').text
    if (name === 'test') { need(text.includes('$ vitest run tests/compat packages'), 'wrong unit scope'); const count = fresh ? fullUnitCount(text) : 518; need(count >= 518, 'incomplete required unit suite'); testsPassed(text, count) }
    else if (name === 'test:system') { testsPassed(text, 34); testsPassed(text, 3); need(text.includes('vite v8.3.3') && text.includes('offline page keeps draft'), 'incomplete full system'); const stress = raw('stress').json(); need(stress.outcome === 'passed' && stress.recoveredRecords === 2000, 'missing system stress outcome') }
    else if (name === 'playwright') { testsPassed(text, fresh ? fullBrowserCount(text) : 87); for (const engine of ['chromium','firefox','webkit']) need((text.match(new RegExp('\\[' + engine + '\\]', 'g')) ?? []).length >= (fresh ? 1 : 29), 'incomplete engine matrix') }
    else if (name === 'test:deploy') validateDeploy(text, identity)
    else if (name === 'check:package') { const result = jsonLines(text).find(l => l.package === 'dsh-web-control'); need(result?.verified === true && result.version === report.versions.plugin && result.sha256 === identity.pluginSha256, 'package check artifact mismatch') }
    else if (name === 'typecheck') need(text.includes('$ tsc --noEmit') && !/error TS[0-9]+|ELIFECYCLE/.test(text), 'typecheck failure/wrong scope')
    else if (name === 'performance') { testsPassed(text, 4); const result = raw('results').json(); need(result.stats.expected === 4 && result.stats.unexpected === 0 && result.stats.skipped === 0 && result.stats.flaky === 0, 'incomplete performance result') }
    else if (name === 'older-page-covering') { testsPassed(text, 3); need(text.includes('older page keeps visible anchor'), 'wrong pagination scope') }
    else if (name === 'color-covering') { need(/Tests\s+1 passed \| 33 skipped/.test(text), 'wrong selected covering scope'); testsPassed(text, 1, 33); testsPassed(text, 3); need(text.includes('RelayDriver counters'), 'wrong environment cover') }
    else if (name === 'validator-fix') { need(check.command.endsWith('exec vitest run tests/compat/acceptance.test.ts --maxWorkers=1 --no-file-parallelism') && /Test Files\s+1 passed \(1\)/.test(text), 'validator covering scope mismatch'); testsPassed(text, fullUnitCount(text)); const inputs = raw('scope-inputs').json(); need(exact(inputs, ['files']) && inputs.files.length === 3 && eq(inputs.files.map(f => f.path).sort(), ['scripts/acceptance-evidence.mjs','scripts/acceptance.mjs','tests/compat/acceptance.test.ts']), 'missing actual fix scope inputs'); for (const input of inputs.files) need(sha256(await readEvidence(resolve(base, input.path), 'validator source')) === input.sha256, 'validator input changed after test') }
    else throw new SafeValidationError('unsupported check scope')
  } else {
    need(exact(receipt.result, ['validator','command','exitCode']) && receipt.result.validator === name && receipt.result.exitCode === 0, 'wrong case result type/exit')
    if (['stock-web','restarts','revocation','native-file-read-failclosed','stock-web-original-session-unload'].includes(name)) {
      const nativeName = name === 'stock-web-original-session-unload' ? 'classic' : 'native', n = raw(nativeName).json(), invocation = raw('invocation').json()
      const command = nativeName === 'native' ? 'scripts/task10-native.mjs --final-ui (entrypoint/flag transcribed; launcher argv not captured)' : 'scripts/compat.mjs --surface web (entrypoint/flags transcribed; launcher argv not captured)'
      if (fresh) {
        const entry = raw('run-ledger').json().find(e => e.name === caseRun)
        const script = nativeName === 'native' ? 'scripts/task10-native.mjs' : 'scripts/compat.mjs'
        need(invocation.capturedAtRun === true && invocation.source === 'actual child launcher' && invocation.childPid === n.runnerPid && Number.isInteger(invocation.childPid) && invocation.childPid > 0 && Array.isArray(invocation.argv) && invocation.argv.some(arg => arg.endsWith(script)) && (nativeName === 'native' ? invocation.argv.includes('--final-ui') && invocation.argv.includes('--final-fix') : invocation.argv.slice(-2).join(' ') === '--surface web') && invocation.command === entry.command && eq(invocation.argv, entry.argv) && invocation.childPid === entry.childPid && invocation.startedAt === entry.startedAt && invocation.finishedAt === entry.finishedAt && invocation.exitCode === 0 && entry.exitCode === 0 && receipt.result.command === invocation.command, 'fresh native invocation mismatch')
      } else need(invocation.source === 'retained Task15 tool-call/report transcription' && invocation.capturedAtRun === false && invocation.command === command && invocation.runnerPid === n.runnerPid && invocation.startedAt === n.startedAt && invocation.finishedAt === n.finishedAt && invocation.exitCode === 0 && receipt.result.command === command, 'native invocation transcription mismatch')
    }
    if (['stock-web','restarts','native-file-read-failclosed'].includes(name)) {
      const n = raw('native').json(), names = validateNative(n, receipt, identity, report.versions, fresh)
      if (fresh) for (const expected of ['same-relay-tombstone-explicit-recovery','explicit-relay-origin-change','fresh-registration-survives-stock-restart','replacement-failure-keeps-fresh-identity','old-tombstone-remains-revoked']) need(names.has(expected), 'missing fresh native replacement scope')
      if (name === 'restarts') for (const expected of lifecycleRequired) need(names.has(expected), 'missing native lifecycle: ' + expected)
      if (name === 'native-file-read-failclosed') need(n.currentReadGate.result === 'PROTOCOL_UNSUPPORTED' && n.currentReadGate.binaryFrames === 0, 'file read did not fail closed')
    } else if (name === 'revocation') { const native = raw('native').json(); const names = validateNative(native, receipt, identity, report.versions, fresh); for (const expected of ['old-link-rejected-after-rotate','stopped-link-rejected']) need(names.has(expected), 'revocation incomplete') }
    else if (name === 'public-relay') {
      need(fresh, 'public relay requires actual fresh WAN proof')
      need(['scripts/public-trial.mjs','scripts/owned-child.mjs'].every(path => raw('source-snapshot').json().files.some(f => f.path === path)), 'public tested runner source missing')
      const n = raw('public-trial').json(), invocation = raw('invocation').json(), entry = raw('run-ledger').json().find(e => e.name === 'public-trial')
      const deployment = raw('deployment').json(), provenance = raw('deployment-source').json(), observed = raw('deployment-observed').json()
      need(n.format === 1 && n.status === 'PASS' && n.checks.every(c => c.ok === true) && publicRequired.every(name => n.checks.some(c => c.name === name && c.ok === true)), 'public native flow incomplete/failed')
      need(n.pluginSha256 === identity.pluginSha256 && eq(n.buildInputs, identity.buildInputs) && n.projectNode === report.versions.projectNode && n.stockNode === report.versions.stockNode && /^[a-f0-9]{40}$/.test(n.source ?? ''), 'public runtime/product binding mismatch')
      need(n.releaseIntegrity === 'sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==', 'public runtime SRI mismatch')
      let origin
      try { origin = new URL(n.publicOrigin) } catch { need(false, 'invalid public origin') }
      need(origin.protocol === 'https:' && origin.origin === n.publicOrigin && !['localhost','127.0.0.1','[::1]'].includes(origin.hostname) && !origin.hostname.endsWith('.localhost') && origin.username === '' && origin.password === '', 'public HTTPS origin required')
      need(eq(n.trust, {defaultTLS:true,customCA:false,ignoreHTTPSErrors:false}) && n.https.url === n.publicOrigin + '/health/ready' && n.https.status === 200 && n.https.ready.ok === true, 'public normal TLS trust missing')
      need(deployment.origin === n.publicOrigin && provenance.publicOrigin === n.publicOrigin && observed.origin === n.publicOrigin && deployment.platform === 'linux/amd64' && provenance.platform === 'linux/amd64' && observed.platform === 'linux/amd64', 'public deployment origin/platform mismatch')
      need(/^sha256:[a-f0-9]{64}$/.test(deployment.image) && deployment.image === observed.imageId && observed.output?.startsWith(JSON.stringify(observed.imageId) + ' ') && deployment.sourceCommit === provenance.sourceCommit && provenance.sourceCommit === observed.sourceCommit && /^[a-f0-9]{40}$/.test(provenance.sourceCommit), 'public deployed image/source mismatch')
      need(deployment.productDigest === identity.buildInputs.digest && provenance.productDigest === identity.buildInputs.digest && observed.productDigest === identity.buildInputs.digest && provenance.productInputs === identity.buildInputs.files && observed.productInputs === identity.buildInputs.files && eq(provenance.files, JSON.parse(await readEvidence(resolve(base, 'dist/release/manifest.json'), 'candidate manifest')).buildSources), 'public deployed product digest mismatch')
      need(Date.parse(observed.capturedAt) <= Date.parse(n.startedAt) && Date.parse(n.startedAt) - Date.parse(observed.capturedAt) <= 3600000, 'public image observation not captured before trial')
      need(invocation.capturedAtRun === true && invocation.source === 'actual runner entry' && invocation.childPid === n.runnerPid && Number.isInteger(n.runnerPid) && n.runnerPid > 0 && eq(invocation.argv, n.argv) && eq(entry.argv, n.argv) && n.argv[0].endsWith('/node/26.8.2/bin/node') && n.argv[1].endsWith('/scripts/public-trial.mjs') && n.argv[n.argv.indexOf('--origin') + 1] === n.publicOrigin && n.argv.includes('--enrollment-file') && entry.childPid === n.runnerPid && entry.command === n.argv.join(' ') && receipt.result.command === entry.command && invocation.sourceSnapshotSha256 === raw('source-snapshot').sha256 && invocation.exitCode === 0, 'public actual invocation mismatch')
      need(n.startedAt === receipt.startedAt && n.finishedAt === receipt.finishedAt && invocation.startedAt === n.startedAt && invocation.finishedAt === n.finishedAt && report.environment.startsWith(n.environment + ';'), 'public chronology/environment mismatch')
      need(typeof n.instanceId === 'string' && typeof n.sessionId === 'string' && n.nativeUI.sessionId === n.sessionId && n.nativeUI.state === 'finished' && n.nativeUI.starts === 2 && n.nativeUI.approvals === 2 && n.nativeUI.stops === 2 && n.nativeUICleanup.clean === true && n.nativeUICleanup.pendingModelStreams === 0 && n.coreResolution.count === 12 && n.coreResolution.singlePublicRuntime === true, 'public original native session/cleanup missing')
      need(n.prompt?.op === 'session.prompt' && n.prompt.sessionId === n.sessionId && n.prompt.content.some(p => p.kind === 'upload' && p.name === 'public-trial.txt' && typeof p.receiptId === 'string'), 'public native uploaded prompt missing')
      need(Array.isArray(n.wss) && n.wss.length >= 2 && n.wss.every(w => w.url === n.publicOrigin.replace('https:', 'wss:') + '/v1/instances/' + n.instanceId + '/control' && typeof w.closed === 'boolean') && n.wss.some(w => w.sent.includes('browser.hello') && w.sent.includes('call') && w.received.includes('ready') && w.received.includes('result')), 'public real WSS proof missing')
      need(n.browser.name === 'Chrome' && /^[0-9]+(?:\.[0-9]+){1,3}$/.test(n.browser.version) && n.browser.physicalPhone === false && n.physicalPhone === false && n.desktop === 'NOT_RUN' && eq(n.viewports.map(v => v.width), [390,1280]) && n.viewports.every(v => v.noOverflow === true), 'public bounded browser scope mismatch')
      need(n.ownedChildren.length === 2 && n.ownedChildren.map(c => c.role).join(',') === 'plugin-install,isolated-stock-web' && n.processes.length === 2 && n.ownedChildren.every(c => Number.isInteger(c.pid) && n.processes.some(p => p.pid === c.pid && p.exitCode === 0 && p.signal === null)) && n.browserClosed === true && n.ownedHomeRemoved === true && n.revocation.status === 401 && n.revocation.code === 'AUTH_REVOKED', 'public owned cleanup/revocation incomplete')
    }
    else if (['deploy-restore','candidate-image-forward-backward'].includes(name)) validateDeploy(raw('deploy').text, identity)
    else if (name === 'stock-web-original-session-unload') { const n = raw('classic').json(); need(n.supported === true && n.surface === 'web' && n.version === report.versions.dsh && n.node === report.versions.stockNode && n.pluginSha256 === identity.pluginSha256 && n.hostExit.code === 0 && n.probe.supported && n.probe.checks.every(c => c.ok), 'classic native mismatch'); for (const expected of ['stock-ui.unload-same-session','stock-host.unload-pending-probe','owned-host.exited']) need(n.checks.some(c => c.name === expected && c.ok), 'classic unload incomplete'); need(fresh ? Date.parse(n.startedAt) >= Date.parse(receipt.startedAt) && Date.parse(n.finishedAt) <= Date.parse(receipt.finishedAt) : n.startedAt === receipt.startedAt && n.finishedAt === receipt.finishedAt, 'classic chronology mismatch') }
    else if (name === 'bounded-upload-stress') { const n = raw('stress').json(); need(n.outcome === 'passed' && n.node === report.versions.projectNode && n.fixtureRecords === 2000 && n.recoveredRecords === 2000 && n.uploadBytes === 33554432 && n.shapedWireBytes === 33576960 && n.configuredBitsPerSecond === 400000 && n.maxHostReservationBytes <= 4*1024*1024 && n.maxRelayRetainedBytes <= 4*1024*1024, 'incomplete/failed bounded stress'); need(n.shaping.includes('binary uplink only'), 'wrong stress scope') }
    else if (name === 'pc-engine-matrix') { const observed = files.filter(f => f.role === 'browser-version').map(f => f.json()).sort((a,b)=>a.engine.localeCompare(b.engine)); need(eq(observed.map(v=>[v.engine,v.version,v.physicalPhone]), fresh ? ['chromium','firefox','webkit'].map(engine => [engine,report.versions[engine],false]) : [['chromium','154.0.8037.98',false],['firefox','157.0',false],['webkit','27.2',false]]), 'browser versions mismatch'); testsPassed(raw('browser').text, fresh ? fullBrowserCount(raw('browser').text) : 87); for (const engine of ['chromium','firefox','webkit']) need((raw('browser').text.match(new RegExp('\\[' + engine + '\\]', 'g')) ?? []).length >= (fresh ? 1 : 29), 'incomplete engine matrix') }
    else if (name === 'pc-scoped-performance') { const n = raw('results').json(); need(Date.parse(n.stats.startTime) >= Date.parse(receipt.startedAt) && Date.parse(n.stats.startTime)+n.stats.duration <= Date.parse(receipt.finishedAt)+1000, 'performance chronology mismatch'); need(n.stats.expected === 4 && n.stats.unexpected === 0 && n.stats.skipped === 0 && n.stats.flaky === 0, 'incomplete performance results'); const metrics = files.filter(f => f.role === 'metrics'); need(metrics.length === 4, 'missing performance metric matrix'); const combinations = new Set(); for (const f of metrics) { const m = f.json(); combinations.add(m.width + ':' + m.bitsPerSecondPerDirection); need(m.browser === (fresh ? report.versions.chromium : '154.0.8037.98') && m.samples.length === 3 && m.samples.every(s => s.loadedRecords === 196 && s.pages === 4) && m.heapPeakBytes > 0 && m.runnerRssPeakBytes > 0, 'performance metric mismatch'); need(Date.parse(m.finishedAt) >= Date.parse(receipt.startedAt) && Date.parse(m.finishedAt) <= Date.parse(receipt.finishedAt), 'metric chronology mismatch'); for (const key of ['loadingMs','recoveryMs','historyLoadMs','scrollMs']) { const values=m.samples.map(s=>s[key]).sort((a,b)=>a-b); need(values.every(v=>Number.isFinite(v)&&v>=0) && m.distribution[key].n===3 && m.distribution[key].median===values[1] && m.distribution[key].p95===values[2], 'metric distribution mismatch') } }; need(eq([...combinations].sort(), ['1280:0','1280:400000','390:0','390:400000']), 'wrong performance combinations') }
    else throw new SafeValidationError('no approved case-specific validator')
  }
  return receipt
}
