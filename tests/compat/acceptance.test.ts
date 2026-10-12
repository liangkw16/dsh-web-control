import { expect, test } from 'vitest'
import { mkdtemp, writeFile, readFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { required, checks, validateReport, currentEvidenceProse } from '../../scripts/acceptance.mjs'
import { sha256, scopeFor, coverage, nativeRequired, lifecycleRequired, publicRequired, freshScope, freshBrowserCases, safeErrorMessage } from '../../scripts/acceptance-evidence.mjs'
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-acceptance-'))
  const put = async (path: string, value: unknown) => { await mkdir(dirname(join(dir, path)), {recursive:true}); await writeFile(join(dir,path),typeof value === 'string'?value:JSON.stringify(value)) }
  const start='2026-10-08T21:38:05.691Z', end='2026-10-08T21:38:18.416Z'
  const versions={projectNode:'v24.18.1',stockNode:'v26.8.2',dsh:'0.2.0-rc.2',plugin:'0.0.0-compat.1',relay:'0.0.0',web:'0.0.0'}
  const source='a'.repeat(40), environment='darwin 25.6.0 arm64; isolated validator fixture'
  await put('sample.ts','export const sample = 1')
  await put('dist/release/sample.ts','export const sample = 1')
  const buildInputs={algorithm:'sha256',digest:sha256('sample.ts\0'+sha256('export const sample = 1')),files:1}
  const lock={source,dirty:true,mode:'local-candidate',buildInputs,relay:{reference:'sha256:'+'b'.repeat(64)}}
  await put('deploy/images.lock.json',lock)
  await put('dist/release/manifest.json',{source,dirty:true,images:lock,buildSources:['sample.ts'],versions,releaseStatus:'BLOCKED'})
  for(const name of ['plugin','relay','web'] as const) await put(`packages/${name}/package.json`,{version:versions[name],peerDependencies:{'@deepseek-ai/dsh':versions.dsh}})
  const paths=['dist/dsh-web-control-0.0.0-compat.1.tgz','dist/dsh-web-control-relay-0.0.0.tgz','deploy/images.lock.json']
  await put(paths[0],'plugin fixture bytes');await put(paths[1],'relay fixture bytes')
  const artifacts=await Promise.all(paths.map(async path=>({path,sha256:sha256(await readFile(join(dir,path)))})))
  const identity={source,dirty:true,buildInputs,pluginSha256:artifacts[0].sha256,relaySha256:artifacts[1].sha256,imageLockSha256:artifacts[2].sha256,imageReference:lock.relay.reference}
  const native={browser:{version:'154.0.8037.98'},viewports:[360,390,768,1280].map(width=>({width,noOverflow:true})),runnerPid:1,status:'PASS',source,dirty:true,buildInputs,pluginSha256:identity.pluginSha256,projectNode:versions.projectNode,stockNode:versions.stockNode,releaseIntegrity:'sha512-EAJ3gPNcVt/uv8X19PMm9NkVhWgT7xXNMk0UKCVm+IQ5rpSQOcsMUa0HWlnYYVybKMsccjcRB21vVVsaXQ6IdA==',environment:'darwin 25.6.0 arm64',startedAt:start,finishedAt:end,checks:[...nativeRequired,...lifecycleRequired].map(name=>({name,ok:true})),processes:[{pid:1,exitCode:0,signal:null},{pid:2,exitCode:0,signal:null}],ephemeralTLSAndEnrollmentRemoved:true,nativeUI:{starts:2,approvals:2,stops:2},nativeUICleanup:{clean:true,pendingModelStreams:0},currentReadGate:{result:'PROTOCOL_UNSUPPORTED',binaryFrames:0}}
  await put('native.json',native)
  const nativeCommand='scripts/task10-native.mjs --final-ui (entrypoint/flag transcribed; launcher argv not captured)'
  await put('invocation.json',{source:'retained Task15 tool-call/report transcription',capturedAtRun:false,command:nativeCommand,runnerPid:1,startedAt:start,finishedAt:end,exitCode:0})
  const command='/task/data/node24/node_modules/node-bin-darwin-arm64/bin/node /runtime/pnpm.mjs run typecheck'
  const check={name:'typecheck',command,startedAt:start,finishedAt:end,exitCode:0,log:'typecheck.log',receipt:'check.json'}
  await put('typecheck.log','$ tsc --noEmit\n');await put('ledger.json',[check])
  const receipt=async(kind:string,name:string,files:Array<{role:string,path:string}>,result:unknown)=>({format:1,kind,name,outcome:'PASS',startedAt:start,finishedAt:end,versions,environment,candidateUnderReview:identity,scope:scopeFor(kind,name),coveredBy:coverage[name]??[],files:await Promise.all(files.map(async f=>({...f,sha256:sha256(await readFile(join(dir,f.path)))}))),result})
  await put('check.json',await receipt('check','typecheck',[{role:'log',path:'typecheck.log'},{role:'run-ledger',path:'ledger.json'}],{command,exitCode:0}))
  const cases:Record<string,{status:string,evidence:string}>=Object.fromEntries(required.map(name=>[name,{status:'NOT_RUN',evidence:'Explicit missing external evidence'}]))
  for(const name of ['stock-web','restarts','revocation','native-file-read-failclosed']) { await put(name+'.json',await receipt('case',name,[{role:'native',path:'native.json'},{role:'invocation',path:'invocation.json'}],{validator:name,command:nativeCommand,exitCode:0}));cases[name]={status:'PASS',evidence:name+'.json'} }
  const report={cases,generatedAt:'2026-10-08T22:00:00.000Z',versions,environment,source,checks:[check],artifacts}
  const expected=[...required.filter(name=>!['stock-web','restarts','revocation'].includes(name)).map(name=>`required gate: ${name} NOT_RUN`),...checks.filter(name=>name!=='typecheck').map(name=>`missing test exit: ${name}`)]
  const editReceipt=async(path:string,edit:(v:any)=>void)=>{const v=JSON.parse(await readFile(join(dir,path),'utf8'));edit(v);await put(path,v)}
  return {dir,report,expected,put,native,editReceipt,close:()=>rm(dir,{recursive:true,force:true})}
}

async function freshEngines(f: Awaited<ReturnType<typeof fixture>>, variant = '') {
 const versions = { chromium:'154.0.8037.99', firefox:'157.0', webkit:'27.2' }
 Object.assign(f.report.versions, versions)
 if (variant === 'malformed declaration') Object.assign(f.report.versions, { chromium:'unrelated-version' })
 const files=[]
 for(const [engine, version] of Object.entries(versions)) {
  const value={engine,version:variant==='mismatched engine'&&engine==='chromium'?'154.0.8037.98':version,physicalPhone:false}, path=engine+'-version.json'
  await f.put(path,value);files.push({role:'browser-version',path,sha256:sha256(JSON.stringify(value))})
 }
 return files
}
test('typed native integration and actual typecheck ledger validate; explicit missing gates stay failed',async()=>{const f=await fixture();try{expect(await validateReport(f.report,f.dir)).toEqual(f.expected)}finally{await f.close()}})
test('review I1 all-PASS README/year2000/zeroSHA/unrelated versions rejected',async()=>{const f=await fixture();try{await f.put('README.md','# unrelated document');for(const c of Object.values(f.report.cases)){c.status='PASS';c.evidence='README.md'};for(const c of f.report.checks){c.log='README.md';c.receipt='README.md';c.startedAt='2000-01-01T00:00:00Z';c.finishedAt='2000-01-01T00:00:01Z'};f.report.source='0'.repeat(40);for(const k of Object.keys(f.report.versions)) (f.report.versions as any)[k]='unrelated-version';const errors=await validateReport(f.report,f.dir);expect(errors.some(v=>v.startsWith('invalid candidate provenance'))).toBe(true);expect(errors.some(v=>v.startsWith('invalid case evidence'))).toBe(true);expect(errors.some(v=>v.startsWith('invalid check evidence'))).toBe(true)}finally{await f.close()}})
test.each(['wrong case','failed receipt','incomplete result','stale package','versions','time','raw bytes','native failed','source fingerprint','arbitrary historical coverage'])('typed case rejects %s',async variant=>{const f=await fixture();try{
 if(variant==='raw bytes')await f.put('native.json',{...f.native,status:'FAIL'})
 else if(variant==='source fingerprint')await f.put('sample.ts','changed after evidence')
 else await f.editReceipt('stock-web.json',v=>{
  if(variant==='wrong case')v.name='restarts'
  if(variant==='failed receipt')v.outcome='FAIL'
  if(variant==='incomplete result')v.result={validator:'deploy-restore'}
  if(variant==='stale package')v.candidateUnderReview.pluginSha256='0'.repeat(64)
  if(variant==='versions')v.versions={...v.versions,stockNode:'v18.0.0'}
  if(variant==='time')v.startedAt='2000-01-01T00:00:00Z'
  if(variant==='arbitrary historical coverage'){v.scope='historical but sufficient';v.coveredBy=[]}
  if(variant==='native failed'){/* Rehashing failed raw data cannot bypass result validation. */}
 })
 if(variant==='native failed'){await f.put('native.json',{...f.native,status:'FAIL'});await f.editReceipt('stock-web.json',v=>{v.files[0].sha256=sha256(JSON.stringify({...f.native,status:'FAIL'}))})}
 const errors=await validateReport(f.report,f.dir);expect(errors.some(v=>v.startsWith('invalid case evidence: stock-web')||v.startsWith('invalid candidate provenance'))).toBe(true)
 }finally{await f.close()}})
test.each(['scope','failed exit','command','receipt time','report time','ledger time','versions','stale image','failed log'])('typed check rejects %s',async variant=>{const f=await fixture();try{
 if(variant==='report time')f.report.checks[0].startedAt='2000-01-01T00:00:00Z'
 else if(variant==='failed log'){await f.put('typecheck.log','$ tsc --noEmit\nerror TS1234');await f.editReceipt('check.json',v=>{v.files[0].sha256=sha256('$ tsc --noEmit\nerror TS1234')})}
 else if(variant==='ledger time'){const ledger=[{...f.report.checks[0],startedAt:'2000-01-01T00:00:00Z'}];await f.put('ledger.json',ledger);await f.editReceipt('check.json',v=>{v.files[1].sha256=sha256(JSON.stringify(ledger))})}
 else await f.editReceipt('check.json',v=>{if(variant==='scope')v.name='test';if(variant==='failed exit')v.result.exitCode=1;if(variant==='command')v.result.command='README';if(variant==='receipt time')v.finishedAt='2000-01-01T00:00:00Z';if(variant==='versions')v.versions={...v.versions,projectNode:'v18'};if(variant==='stale image')v.candidateUnderReview.imageReference='sha256:'+'0'.repeat(64)})
 expect((await validateReport(f.report,f.dir)).some(v=>v.startsWith('invalid check evidence: typecheck'))).toBe(true)
 }finally{await f.close()}})
test('genuine new artifact hashes cannot make prior native receipt current',async()=>{const f=await fixture();try{await f.put(f.report.artifacts[0].path,'new genuine packed bytes');f.report.artifacts[0].sha256=sha256('new genuine packed bytes');expect((await validateReport(f.report,f.dir)).some(v=>v.includes('receipt candidate/version/environment mismatch'))).toBe(true)}finally{await f.close()}})
test.each([null,[],{}, {cases:{}}])('malformed report rejects %s',async value=>{expect(await validateReport(value)).toEqual(['invalid report schema'])})

test.each(['captured','missing ledger capture','captured after run','stale captured source'])('fresh evidence %s requires actual pre-run snapshot, not historical exemption', async variant => {
 const f=await fixture();try {
  const snapshot={capturedAt:variant==='captured after run'?'2026-10-08T21:38:06.000Z':'2026-10-08T21:38:04.000Z',buildInputs:f.native.buildInputs,files:[{path:'sample.ts',sha256:variant==='stale captured source'?'0'.repeat(64):sha256('export const sample = 1')}]}
  await f.put('snapshot.json',snapshot)
  const snapshotSha=sha256(JSON.stringify(snapshot))
  const ledger=[{...f.report.checks[0],...(variant==='missing ledger capture'?{}:{sourceSnapshotSha256:snapshotSha})}]
  await f.put('ledger.json',ledger)
  await f.editReceipt('check.json',v=>{v.scope=freshScope;v.coveredBy=[];v.files[1].sha256=sha256(JSON.stringify(ledger));v.files.push({role:'source-snapshot',path:'snapshot.json',sha256:snapshotSha})})
  const errors=await validateReport(f.report,f.dir)
  if(variant==='captured')expect(errors).toEqual(f.expected)
  else expect(errors.some(v=>v.startsWith('invalid check evidence: typecheck'))).toBe(true)
 }finally{await f.close()}
})

test.each(['SGR pass','SGR fail','incomplete total'])('raw hashed %s summary is parsed strictly',async variant=>{
 const f=await fixture();try{
  const command='/task/data/node24/node_modules/node-bin-darwin-arm64/bin/node /runtime/pnpm.mjs exec vitest run tests/compat/acceptance.test.ts --maxWorkers=1 --no-file-parallelism'
  Object.assign(f.report.checks[0],{name:'validator-fix',command})
  const text='\u001b[32m Test Files  1 passed (1)\u001b[0m\n Tests  '+(variant==='incomplete total'?'30 passed (31)':'31 passed (31)')+'\n'+(variant==='SGR fail'?'\u001b[31m1 failed\u001b[0m\n':'')
  await f.put('typecheck.log',text);await f.put('ledger.json',f.report.checks)
  const paths=['scripts/acceptance-evidence.mjs','scripts/acceptance.mjs','tests/compat/acceptance.test.ts'];for(const path of paths)await f.put(path,'scoped fixture input')
  const snapshot={files:paths.map(path=>({path,sha256:sha256('scoped fixture input')}))};await f.put('scope.json',snapshot)
  await f.editReceipt('check.json',v=>{v.name='validator-fix';v.scope=scopeFor('check','validator-fix');v.result.command=command;v.files[0].sha256=sha256(text);v.files[1].sha256=sha256(JSON.stringify(f.report.checks));v.files.push({role:'scope-inputs',path:'scope.json',sha256:sha256(JSON.stringify(snapshot))})})
  const errors=await validateReport(f.report,f.dir);expect(errors.some(v=>v.startsWith('invalid check evidence: validator-fix'))).toBe(variant!=='SGR pass')
 }finally{await f.close()}
})

const diagnosticMarker = 'LINK_SECRET_SYNTHETIC'
const diagnosticPrefix = 'LINK_SECRE'
test.each(['receipt','raw role','candidate lock','candidate manifest','candidate package','candidate IO','raw IO','unexpected raw'])('diagnostic %s is content-free in failures and actual CLI output',async variant=>{
 const f=await fixture();try{
  if(variant==='receipt')await f.put('stock-web.json',diagnosticMarker)
  else if(variant==='raw role'||variant==='unexpected raw'){
   const bytes=variant==='raw role'?diagnosticMarker:JSON.stringify({status:'PASS',pluginSha256:f.report.artifacts[0].sha256,source:f.report.source,dirty:true,buildInputs:f.native.buildInputs,projectNode:f.report.versions.projectNode,stockNode:f.report.versions.stockNode,releaseIntegrity:f.native.releaseIntegrity,startedAt:f.native.startedAt,finishedAt:f.native.finishedAt,environment:f.native.environment,checks:null})
   await f.put('native.json',bytes);await f.editReceipt('stock-web.json',v=>{v.files[0].sha256=sha256(bytes)})
  }else if(variant==='raw IO')await f.editReceipt('stock-web.json',v=>{v.files[0].path=diagnosticMarker+'.json'})
  else if(variant==='candidate IO')await rm(join(f.dir,'dist/release/manifest.json'))
  else await f.put({'candidate lock':'deploy/images.lock.json','candidate manifest':'dist/release/manifest.json','candidate package':'packages/plugin/package.json'}[variant]!,diagnosticMarker)
  const errors=await validateReport(f.report,f.dir)
  expect(errors.some(v=>v.startsWith(variant.startsWith('candidate')?'invalid candidate provenance':'invalid case evidence: stock-web'))).toBe(true)
  expect(errors.join('\n')).not.toContain(diagnosticPrefix)
  expect(errors.join('\n')).not.toMatch(/Unexpected token|is not valid JSON|ENOENT|Cannot read properties/)
  await f.put('input.json',f.report)
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('../../scripts/acceptance.mjs',import.meta.url)),'--input','input.json','--report','output.md'],{cwd:f.dir,encoding:'utf8'})
  expect(run.status).toBe(1)
  const emitted=run.stdout+run.stderr+await readFile(join(f.dir,'output.md'),'utf8')
  expect(emitted).not.toContain(diagnosticPrefix)
  expect(emitted).not.toMatch(/Unexpected token|is not valid JSON|ENOENT|Cannot read properties/)
 }finally{await f.close()}
})
test('diagnostic arbitrary exceptions never forward their message',()=>{
 expect(safeErrorMessage(new Error(diagnosticMarker))).toBe('unexpected evidence error')
 expect(safeErrorMessage({message:diagnosticMarker})).toBe('unexpected evidence error')
})
test('diagnostic output IO failure is fixed in actual CLI stdout',async()=>{
 const f=await fixture();try{
  await f.put('input.json',f.report);await f.put('blocked','regular file')
  const run=spawnSync(process.execPath,[fileURLToPath(new URL('../../scripts/acceptance.mjs',import.meta.url)),'--input','input.json','--report','blocked/'+diagnosticMarker+'.md'],{cwd:f.dir,encoding:'utf8'})
  expect(run.status).toBe(1);expect(JSON.parse(run.stdout).failures).toEqual(['acceptance processing failed'])
  expect(run.stdout+run.stderr).not.toContain(diagnosticPrefix)
 }finally{await f.close()}
})

test.each(['captured', 'transcribed', 'wrong pid', 'wrong argv', 'late capture', 'missing replacement', 'mismatched native'])('fresh native receipt %s preserves exact invocation/source/result requirements', async variant => {
  const f = await fixture()
  try {
    const engineFiles = await freshEngines(f)
    const native = { ...f.native, browser: { version: variant === 'mismatched native' ? '154.0.8037.98' : '154.0.8037.99' }, checks: [...f.native.checks, ...['same-relay-tombstone-explicit-recovery','explicit-relay-origin-change','fresh-registration-survives-stock-restart','replacement-failure-keeps-fresh-identity','old-tombstone-remains-revoked'].map(name => ({ name, ok: true }))] }
    if (variant === 'missing replacement') native.checks.pop()
    await f.put('native.json', native)
    const snapshot = { capturedAt: variant === 'late capture' ? native.finishedAt : '2026-10-08T21:38:04.000Z', buildInputs: native.buildInputs, files: [{ path: 'sample.ts', sha256: sha256('export const sample = 1') }] }
    await f.put('snapshot.json', snapshot); await f.put('native.log', 'actual bounded fixture log')
    const argv = ['/task/node26/bin/node', 'scripts/task10-native.mjs', '--final-ui', '--final-fix']
    const entry = { name: 'native', command: argv.join(' '), argv, childPid: native.runnerPid, startedAt: native.startedAt, finishedAt: native.finishedAt, exitCode: 0, log: 'native.log', sourceSnapshotSha256: sha256(JSON.stringify(snapshot)) }
    await f.put('native-ledger.json', [entry])
    const invocation = { ...entry, capturedAtRun: variant !== 'transcribed', source: 'actual child launcher', ...(variant === 'wrong pid' ? { childPid: 2 } : {}), ...(variant === 'wrong argv' ? { argv: ['README'] } : {}) }
    await f.put('fresh-invocation.json', invocation)
    await f.editReceipt('stock-web.json', value => { value.scope = freshScope; value.coveredBy = []; value.versions = f.report.versions; value.result.command = entry.command; value.files = [...engineFiles,
      { role: 'native', path: 'native.json', sha256: sha256(JSON.stringify(native)) },
      { role: 'invocation', path: 'fresh-invocation.json', sha256: sha256(JSON.stringify(invocation)) },
      { role: 'source-snapshot', path: 'snapshot.json', sha256: sha256(JSON.stringify(snapshot)) },
      { role: 'run-ledger', path: 'native-ledger.json', sha256: sha256(JSON.stringify([entry])) },
      { role: 'run-log', path: 'native.log', sha256: sha256('actual bounded fixture log') },
    ] })
    const errors = await validateReport(f.report, f.dir)
    expect(errors.some(error => error.startsWith('invalid case evidence: stock-web:'))).toBe(variant !== 'captured')
  } finally { await f.close() }
})
test.each(['complete', 'missing behavior', 'failed result', 'unbound inventory', 'count mismatch', 'mismatched engine', 'malformed declaration'])('fresh browser %s validates exact inventory and all required behaviors', async variant => {
  const f = await fixture()
  try {
    const engineFiles = await freshEngines(f, variant)
    const cases = ['chromium','firefox','webkit'].flatMap(project => freshBrowserCases.map(item => ({ ...item, project })))
    if (variant === 'missing behavior') cases.pop()
    const scope = { cases }, snapshot = { capturedAt: '2026-10-08T21:38:04.000Z', buildInputs: f.native.buildInputs, files: [{ path: 'sample.ts', sha256: sha256('export const sample = 1') }] }
    const count = cases.length, result = { stats: { expected: count, unexpected: 0, skipped: 0, flaky: 0, startTime: f.report.checks[0].startedAt, duration: 1000 }, suites: [{ specs: cases.map(item => ({ file: item.file, title: item.title, tests: [{ projectName: item.project, status: 'expected', results: [{ status: variant === 'failed result' ? 'failed' : 'passed' }] }] })) }] }
    const command = '/task/data/node24/node_modules/node-bin-darwin-arm64/bin/node /runtime/pnpm.mjs exec playwright test --workers=1'
    const text = '[chromium]\n[firefox]\n[webkit]\n  ' + (variant === 'count mismatch' ? count + 1 : count) + ' passed (1.0s)\n'
    Object.assign(f.report.checks[0], { name: 'playwright', command })
    const entry = { ...f.report.checks[0], sourceSnapshotSha256: sha256(JSON.stringify(snapshot)), ...(variant === 'unbound inventory' ? {} : { scopeInputsSha256: sha256(JSON.stringify(scope)) }) }
    const files = [{ role: 'log', path: 'typecheck.log', value: text }, { role: 'run-ledger', path: 'ledger.json', value: [entry] }, { role: 'source-snapshot', path: 'snapshot.json', value: snapshot }, { role: 'scope-inputs', path: 'browser-scope.json', value: scope }, { role: 'results', path: 'results.json', value: result }]
    for (const file of files) await f.put(file.path, file.value)
    await f.editReceipt('check.json', value => { value.name = 'playwright'; value.versions = f.report.versions; value.scope = freshScope; value.coveredBy = []; value.result.command = command; value.files = [...engineFiles, ...files.map(file => ({ role: file.role, path: file.path, sha256: sha256(typeof file.value === 'string' ? file.value : JSON.stringify(file.value)) }))] })
    const errors = await validateReport(f.report, f.dir)
    if (variant === 'complete') {
      expect(errors.filter(error => error.startsWith('invalid check evidence: playwright:'))).toEqual([])
      const caseReceipt = JSON.parse(await readFile(join(f.dir,'check.json'),'utf8'))
      Object.assign(caseReceipt,{kind:'case',name:'pc-engine-matrix',result:{validator:'pc-engine-matrix',command,exitCode:0}})
      caseReceipt.files.find((file:any)=>file.role==='log').role='browser'
      await f.put('engine-case.json',caseReceipt);f.report.cases['pc-engine-matrix']={status:'PASS',evidence:'engine-case.json'}
      expect((await currentEvidenceProse(f.report,f.dir))['pc-browser-versions']).toContain('Chrome 154.0.8037.99, Firefox 157.0, managed WebKit 27.2')
    }
    else expect(errors.some(error => error.startsWith('invalid check evidence: playwright:'))).toBe(true)
  } finally { await f.close() }
})

test.each(['complete', 'subset count', 'wrong scope'])('fresh unit %s cannot replace the required suite with a labeled subset', async variant => {
 const f=await fixture();try {
  const command='/task/data/node24/node_modules/node-bin-darwin-arm64/bin/node /runtime/pnpm.mjs test'
  const count=variant==='subset count'?1:518
  const text=(variant==='wrong scope'?'$ vitest run one.test.ts':'$ vitest run tests/compat packages')+'\n Tests '+count+' passed ('+count+')\n'
  Object.assign(f.report.checks[0],{name:'test',command})
  const snapshot={capturedAt:'2026-10-08T21:38:04.000Z',buildInputs:f.native.buildInputs,files:[{path:'sample.ts',sha256:sha256('export const sample = 1')}]}
  const ledger=[{...f.report.checks[0],sourceSnapshotSha256:sha256(JSON.stringify(snapshot))}]
  await f.put('snapshot.json',snapshot);await f.put('ledger.json',ledger);await f.put('typecheck.log',text)
  await f.editReceipt('check.json',v=>{v.name='test';v.result.command=command;v.scope=freshScope;v.coveredBy=[];v.files[0].sha256=sha256(text);v.files[1].sha256=sha256(JSON.stringify(ledger));v.files.push({role:'source-snapshot',path:'snapshot.json',sha256:sha256(JSON.stringify(snapshot))})})
  const errors=await validateReport(f.report,f.dir)
  expect(errors.some(v=>v.startsWith('invalid check evidence: test:'))).toBe(variant!=='complete')
 }finally{await f.close()}
})

test.each(['complete','mismatched measurement','mismatched engine'])('fresh performance %s agrees with declared captured engine tuple', async variant => {
 const f=await fixture();try {
  const engines=await freshEngines(f,variant), start=f.native.startedAt, end=f.native.finishedAt
  const snapshot={capturedAt:'2026-10-08T21:38:04.000Z',buildInputs:f.native.buildInputs,files:[{path:'sample.ts',sha256:sha256('export const sample = 1')}]}
  const command='/task/data/node24/node_modules/node-bin-darwin-arm64/bin/node /runtime/pnpm.mjs exec playwright test tests/e2e/performance.spec.ts --project=chromium --workers=1'
  const ledger=[{name:'performance',command,startedAt:start,finishedAt:end,exitCode:0,log:'performance.log',sourceSnapshotSha256:sha256(JSON.stringify(snapshot))}]
  const result={stats:{expected:4,unexpected:0,skipped:0,flaky:0,startTime:start,duration:1000}}
  const files:Array<{role:string,path:string,value:unknown}>=[{role:'run-log',path:'performance.log',value:'  4 passed (1.0s)\n'},{role:'run-ledger',path:'performance-ledger.json',value:ledger},{role:'source-snapshot',path:'snapshot.json',value:snapshot},{role:'results',path:'performance-results.json',value:result}]
  for(const width of [390,1280])for(const bitsPerSecondPerDirection of [0,400000]){
   const samples=[1,2,3].map(value=>({loadedRecords:196,pages:4,loadingMs:value,recoveryMs:value,historyLoadMs:value,scrollMs:value}))
   files.push({role:'metrics',path:`metrics-${width}-${bitsPerSecondPerDirection}.json`,value:{width,bitsPerSecondPerDirection,browser:variant==='mismatched measurement'?'154.0.8037.98':'154.0.8037.99',samples,heapPeakBytes:1,runnerRssPeakBytes:1,finishedAt:end,distribution:Object.fromEntries(['loadingMs','recoveryMs','historyLoadMs','scrollMs'].map(key=>[key,{n:3,median:2,p95:3}]))}})
  }
  for(const file of files)await f.put(file.path,file.value)
  const receipt=JSON.parse(await readFile(join(f.dir,'check.json'),'utf8'))
  Object.assign(receipt,{kind:'case',name:'pc-scoped-performance',versions:f.report.versions,scope:freshScope,coveredBy:[],result:{validator:'pc-scoped-performance',command,exitCode:0},files:[...engines,...files.map(file=>({role:file.role,path:file.path,sha256:sha256(typeof file.value==='string'?file.value:JSON.stringify(file.value))}))]})
  await f.put('performance.json',receipt);f.report.cases['pc-scoped-performance']={status:'PASS',evidence:'performance.json'}
  const errors=await validateReport(f.report,f.dir)
  expect(errors.some(error=>error.startsWith('invalid case evidence: pc-scoped-performance:'))).toBe(variant!=='complete')
 }finally{await f.close()}
})

test('fixed v1 file deferral never exempts the other nine missing release gates',async()=>{const f=await fixture();try{
 expect(required).not.toContain('current-file-preview')
 const gates=['stock-desktop','ios-cellular','android-cellular','pc-browsers','public-relay','registry-release','performance','pc-browser-versions','released-version-lifecycle']
 for(const gate of gates){const saved=f.report.cases[gate];delete f.report.cases[gate];expect(await validateReport(f.report,f.dir)).toContain(`required gate: ${gate} MISSING`);f.report.cases[gate]={status:'DEFERRED',evidence:'Caller asks to skip'};expect(await validateReport(f.report,f.dir)).toContain(`required gate: ${gate} DEFERRED`);f.report.cases[gate]=saved}
 f.report.cases['current-file-preview']={status:'PASS',evidence:'README.md'}
 expect((await validateReport(f.report,f.dir)).some(v=>v.startsWith('invalid case evidence:'))).toBe(true)
 }finally{await f.close()}})

test('generated lifecycle prose follows validated raw candidate swap and rejects tampered bytes',async()=>{const f=await fixture();try{
 const previousImage='sha256:913f833'+'1'.repeat(57),currentImage='sha256:'+'b'.repeat(64)
 const phases=[{phase:'https-wss-ready',gateway:'caddy'},{phase:'https-wss-ready',gateway:'nginx'},{phase:'restart-backup-restore-passed'},{phase:'offline-enrollment-rotation-recreated'},{phase:'exact-project-cleanup'},{phase:'candidate-image-forward-backward',previousImage,currentImage}]
 const text=phases.map(p=>JSON.stringify(p)).join('\n')+'\nIsolated deployment smoke PASS\n',command='actual fixture deployment command'
 await f.put('deploy.log',text);await f.put('deploy-ledger.json',[{name:'test:deploy',command,startedAt:f.native.startedAt,finishedAt:f.native.finishedAt,exitCode:0,log:'deploy.log'}])
 const receipt=JSON.parse(await readFile(join(f.dir,'check.json'),'utf8'));Object.assign(receipt,{kind:'case',name:'candidate-image-forward-backward',scope:scopeFor('case','candidate-image-forward-backward'),result:{validator:'candidate-image-forward-backward',command,exitCode:0},files:[{role:'deploy',path:'deploy.log',sha256:sha256(text)},{role:'run-ledger',path:'deploy-ledger.json',sha256:sha256(await readFile(join(f.dir,'deploy-ledger.json')))}]})
 await f.put('swap.json',receipt);f.report.cases['candidate-image-forward-backward']={status:'PASS',evidence:'swap.json'}
 expect((await currentEvidenceProse(f.report,f.dir))['released-version-lifecycle']).toContain('913f833… ↔ bbbbbbb…')
 await f.put('deploy.log',text+'tampered');expect((await currentEvidenceProse(f.report,f.dir))['released-version-lifecycle']).toBeUndefined()
 }finally{await f.close()}})

async function publicFixture() {
 const f=await fixture(), n={...f.native,format:1,source:f.report.source,publicOrigin:'https://203.0.113.25:8443',desktop:'NOT_RUN',physicalPhone:false,trust:{defaultTLS:true,customCA:false,ignoreHTTPSErrors:false},https:{url:'https://203.0.113.25:8443/health/ready',status:200,ready:{ok:true}},instanceId:'owned-instance',sessionId:'owned-session',checks:publicRequired.map(name=>({name,ok:true})),browser:{name:'Chrome',version:'154.0.8037.99',physicalPhone:false},viewports:[390,1280].map(width=>({width,noOverflow:true})),nativeUI:{state:'finished',sessionId:'owned-session',starts:2,approvals:2,stops:2},coreResolution:{count:12,singlePublicRuntime:true},prompt:{op:'session.prompt',sessionId:'owned-session',content:[{kind:'upload',name:'public-trial.txt',receiptId:'owned-receipt'}]},wss:[0,1].map(()=>({url:'wss://203.0.113.25:8443/v1/instances/owned-instance/control',sent:['browser.hello','call'],received:['ready','result'],closed:true})),ownedChildren:[{role:'plugin-install',pid:1},{role:'isolated-stock-web',pid:2}],browserClosed:true,ownedHomeRemoved:true,revocation:{status:401,code:'AUTH_REVOKED'},argv:['/opt/node/26.8.2/bin/node','/task/scripts/public-trial.mjs','--origin','https://203.0.113.25:8443','--enrollment-file','/task/private-secret']}
 await f.put('public-native.json',n)
 await f.put('scripts/public-trial.mjs','owned runner fixture');await f.put('scripts/owned-child.mjs','owned child fixture')
 const snapshot={capturedAt:'2026-10-08T21:38:04.000Z',buildInputs:n.buildInputs,files:await Promise.all(['sample.ts','scripts/public-trial.mjs','scripts/owned-child.mjs'].map(async path=>({path,sha256:sha256(await readFile(join(f.dir,path)))})))}
 await f.put('public-source.json',snapshot)
 const capture={capturedAtRun:true,source:'actual runner entry',childPid:1,argv:n.argv,startedAt:n.startedAt,finishedAt:n.finishedAt,sourceSnapshotSha256:sha256(JSON.stringify(snapshot)),exitCode:0}
 await f.put('public-invocation.json',capture)
 const entry={name:'public-trial',argv:n.argv,childPid:1,command:n.argv.join(' '),startedAt:n.startedAt,finishedAt:n.finishedAt,sourceSnapshotSha256:capture.sourceSnapshotSha256,exitCode:0,log:'public.log'}
 await f.put('public-ledger.json',[entry]);await f.put('public.log','actual owned Host output')
 const image='sha256:'+'c'.repeat(64), source='d'.repeat(40)
 await f.put('deployment.json',{origin:n.publicOrigin,platform:'linux/amd64',image,sourceCommit:source,productDigest:n.buildInputs.digest})
 await f.put('deployment-source.json',{publicOrigin:n.publicOrigin,platform:'linux/amd64',sourceCommit:source,productDigest:n.buildInputs.digest,productInputs:1,files:['sample.ts']})
 await f.put('deployment-observed.json',{capturedAt:snapshot.capturedAt,origin:n.publicOrigin,platform:'linux/amd64',imageId:image,output:JSON.stringify(image)+' \"10001:10001\" true {}',sourceCommit:source,productDigest:n.buildInputs.digest,productInputs:1})
 const template=JSON.parse(await readFile(join(f.dir,'stock-web.json'),'utf8'))
 Object.assign(template,{name:'public-relay',scope:freshScope,coveredBy:[],result:{validator:'public-relay',command:entry.command,exitCode:0}})
 template.files=await Promise.all([['public-trial','public-native.json'],['source-snapshot','public-source.json'],['invocation','public-invocation.json'],['run-ledger','public-ledger.json'],['run-log','public.log'],['deployment','deployment.json'],['deployment-source','deployment-source.json'],['deployment-observed','deployment-observed.json']].map(async([role,path])=>({role,path,sha256:sha256(await readFile(join(f.dir,path)))})))
 await f.put('public-receipt.json',template);f.report.cases['public-relay']={status:'PASS',evidence:'public-receipt.json'}
 const rehash=async(path:string,edit:(v:any)=>void)=>{const raw=JSON.parse(await readFile(join(f.dir,path),'utf8'));edit(raw);await f.put(path,raw);await f.editReceipt('public-receipt.json',v=>{v.files.find((file:any)=>file.path===path).sha256=sha256(JSON.stringify(raw))})}
 return {...f,n,rehash}
}
test('typed public WAN proof validates without changing local arm64 identity or other required gates',async()=>{const f=await publicFixture();try{expect(await validateReport(f.report,f.dir)).toEqual(f.expected.filter(v=>v!=='required gate: public-relay NOT_RUN'))}finally{await f.close()}})
test.each(['health only forged PASS','untrusted TLS','wrong origin','wrong image','wrong product digest','missing native','missing WSS','missing runner source','failed cleanup','forged invocation'])('public WAN rejects %s even when raw bytes are rehashed',async variant=>{const f=await publicFixture();try{
 if(variant==='wrong image')await f.rehash('deployment-observed.json',v=>{v.imageId='sha256:'+'e'.repeat(64)})
 else if(variant==='wrong product digest')await f.rehash('deployment-source.json',v=>{v.productDigest='0'.repeat(64)})
 else if(variant==='missing runner source')await f.rehash('public-source.json',v=>{v.files=v.files.filter((p:any)=>p.path==='sample.ts')})
 else if(variant==='forged invocation')await f.rehash('public-invocation.json',v=>{v.childPid=999})
 else await f.rehash('public-native.json',v=>{
  if(variant==='health only forged PASS'){v.checks=[{name:'normal-trust-public-https',ok:true}];delete v.nativeUI;delete v.wss}
  if(variant==='untrusted TLS')v.trust.ignoreHTTPSErrors=true
  if(variant==='wrong origin')v.publicOrigin='https://203.0.113.26:8443'
  if(variant==='missing native')v.nativeUI.starts=0
  if(variant==='missing WSS')v.wss=[]
  if(variant==='failed cleanup')v.revocation.code='AUTH_FAILED'
 })
 expect((await validateReport(f.report,f.dir)).some(v=>v.startsWith('invalid case evidence: public-relay'))).toBe(true)
 }finally{await f.close()}})
