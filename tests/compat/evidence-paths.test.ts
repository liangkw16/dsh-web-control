import { test, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync, readdirSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
const helper = resolve('scripts/evidence-paths.mjs'), runner = resolve('scripts/test-system.mjs')
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('WEB_CONTROL_')))
function sandbox(run: (dir: string) => void) { const dir = mkdtempSync(join(tmpdir(), 'dsh-evidence-')); try { run(dir) } finally { rmSync(dir, {recursive:true,force:true}) } }
const probe = (dir: string, code: string, env: Record<string,string> = {}, args: string[] = []) => spawnSync(process.execPath, ['--input-type=module', '-e', `import { claimEvidenceDirectory, browserEvidenceDirectories } from ${JSON.stringify(helper)}; ${code}`, '--', ...args], {cwd:dir,env:{...cleanEnv(),...env},encoding:'utf8'})
const json = (output: string) => JSON.parse(output.trim().split('\n').at(-1)!)
test('two ordinary browser invocations own separate browser/performance output and record metadata once', () => sandbox(dir => {
 const code = 'const paths=browserEvidenceDirectories(); console.log(JSON.stringify({...paths, again:browserEvidenceDirectories()}))'
 const a=probe(dir,code), b=probe(dir,code);expect(a.status).toBe(0);expect(b.status).toBe(0)
 const first=json(a.stdout), second=json(b.stdout);expect(first.browser).not.toBe(second.browser);expect(first.performance).not.toBe(second.performance)
 expect(first.again).toEqual({browser:first.browser,performance:first.performance});expect(first.performance.startsWith(first.browser+'/')).toBe(true)
 expect(readdirSync(first.browser).filter(p=>p==='invocation.json')).toHaveLength(1)
}))
test.each(['system','performance'] as const)('direct %s writer fallback owns fresh paths and inherited children reuse only that claim', kind => sandbox(dir => {
 const code=`const path=claimEvidenceDirectory('${kind}'); console.log(JSON.stringify({path,env:process.env}))`
 const a=probe(dir,code), b=probe(dir,code);expect(a.status).toBe(0);expect(b.status).toBe(0);const first=json(a.stdout);expect(first.path).not.toBe(json(b.stdout).path)
 const child=probe(dir,code,first.env);expect(child.status).toBe(0);expect(json(child.stdout).path).toBe(first.path)
 const owner=JSON.parse(readFileSync(join(first.path,'invocation.json'),'utf8'));expect(owner.pid).toBeGreaterThan(0);expect(owner.kind).toBe(kind)
}))
test.each(['browser','system','performance'] as const)('explicit %s reuse cannot overwrite history even with legacy owner PID', kind => sandbox(dir => {
 const variable={browser:'WEB_CONTROL_EVIDENCE_DIR',system:'WEB_CONTROL_SYSTEM_DIR',performance:'WEB_CONTROL_PERFORMANCE_DIR'}[kind]
 const path=join(dir,'explicit'), code=`console.log(JSON.stringify({path:claimEvidenceDirectory('${kind}')}))`, env={[variable]:path,WEB_CONTROL_RUN_OWNER_PID:'123'}
 expect(probe(dir,code,env).status).toBe(0);writeFileSync(join(path,'retained.json'),'historical bytes');const before=readFileSync(join(path,'invocation.json'),'utf8')
 expect(probe(dir,code,env).status).not.toBe(0);expect(readFileSync(join(path,'retained.json'),'utf8')).toBe('historical bytes');expect(readFileSync(join(path,'invocation.json'),'utf8')).toBe(before)
 expect(probe(dir,code,{...env,[variable+'_TOKEN']:'forged'}).status).not.toBe(0)
}))
test('wrapped explicit empty directories are claimed without changing the requested paths', () => sandbox(dir => {
 const browser=join(dir,'browser'), performance=join(dir,'performance');const result=probe(dir,'console.log(JSON.stringify(browserEvidenceDirectories()))',{WEB_CONTROL_EVIDENCE_DIR:browser,WEB_CONTROL_PERFORMANCE_DIR:performance})
 expect(result.status).toBe(0);expect(json(result.stdout)).toEqual({browser,performance})
}))
test('system runner claims before spawn and passes owned directory/token to every phase', () => sandbox(dir => {
 const launcher=join(dir,'launcher.mjs');writeFileSync(launcher,"import { appendFileSync,existsSync } from 'node:fs'; appendFileSync('children.jsonl',JSON.stringify({argv:process.argv,dir:process.env.WEB_CONTROL_SYSTEM_DIR,token:process.env.WEB_CONTROL_SYSTEM_DIR_TOKEN,claimed:existsSync(process.env.WEB_CONTROL_SYSTEM_DIR+'/invocation.json')})+'\\n')")
 const launch=()=>spawnSync(process.execPath,[runner],{cwd:dir,env:{...cleanEnv(),npm_execpath:launcher},encoding:'utf8'})
 expect(launch().status).toBe(0);expect(launch().status).toBe(0)
 const children=readFileSync(join(dir,'children.jsonl'),'utf8').trim().split('\n').map(v=>JSON.parse(v));expect(children).toHaveLength(6)
 expect(new Set(children.slice(0,3).map(v=>v.dir)).size).toBe(1);expect(children[0].dir).not.toBe(children[3].dir)
 for(const child of children){expect(child.claimed).toBe(true);expect(child.token).toBeTruthy();expect(JSON.parse(readFileSync(join(child.dir,'invocation.json'),'utf8')).token).toBe(child.token)}
}))

test('wrapped inventory child leaves actual performance path unclaimed for the separate run child', () => sandbox(dir => {
 const performance=join(dir,'performance'), code='console.log(JSON.stringify(browserEvidenceDirectories()))'
 const parentEnv={WEB_CONTROL_PERFORMANCE_DIR:performance}
 const inventory=probe(dir,code,{...parentEnv,WEB_CONTROL_EVIDENCE_DIR:join(dir,'inventory')},['--list'])
 expect(inventory.status).toBe(0);const listed=json(inventory.stdout)
 expect(listed.performance).not.toBe(performance);expect(listed.performance.startsWith(listed.browser+'/')).toBe(true)
 expect(existsSync(performance)).toBe(false)
 // Child mutations cannot return generated tokens to the wrapper's parent environment.
 const actual=probe(dir,code,{...parentEnv,WEB_CONTROL_EVIDENCE_DIR:join(dir,'browser')})
 expect(actual.status).toBe(0);expect(json(actual.stdout).performance).toBe(performance)
 const before=readFileSync(join(performance,'invocation.json'),'utf8')
 const reuse=probe(dir,code,{...parentEnv,WEB_CONTROL_EVIDENCE_DIR:join(dir,'later-browser')})
 expect(reuse.status).not.toBe(0);expect(readFileSync(join(performance,'invocation.json'),'utf8')).toBe(before)
}))
