/** Build a public distribution from pinned, verified UI inputs. Never reads a DSH profile. */
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import { assembleUiRelease } from './native-ui-resources.mjs'
import { verifyUiRelease } from '../packages/relay/dist/ui-assets.js'
const root=resolve(import.meta.dirname,'..')
const {values}=parseArgs({options:{inputs:{type:'string'},output:{type:'string'}}})
const inputs=resolve(values.inputs??join(root,'data/native-inputs'))
const output=resolve(values.output??join(root,'dist/public-release'))
const pkg=JSON.parse(await readFile(join(root,'packages/plugin/package.json'),'utf8'))
const pnpm=process.env.WEB_CONTROL_PNPM_CLI??join(root,'node_modules/pnpm/bin/pnpm.mjs')
const hash=bytes=>createHash('sha256').update(bytes).digest('hex')
const run=(cmd,args)=>execFileSync(cmd,args,{cwd:root,stdio:'inherit'})
await mkdir(dirname(output), { recursive: true })
await mkdir(output) // Refuse to overwrite a previously published bundle.
run(process.execPath,[pnpm,'--filter','dsh-web-control','pack','--pack-destination',output])
await mkdir(join(output,'plugin'));await cp(join(root,'packages/plugin/dist'),join(output,'plugin/dist'),{recursive:true});await cp(join(root,'packages/plugin/package.json'),join(output,'plugin/package.json'))
run(process.execPath,[join(root,'scripts/check-package.mjs'),output])
const kitName=`dsh-web-control-deploy-${pkg.version}`,kit=join(output,kitName)
await mkdir(kit)
const source=execFileSync('git',['ls-files'],{cwd:root,encoding:'utf8'}).trim().split('\n').filter(Boolean)
if(!source.includes('LICENSE'))throw new Error('Stage the complete public source before packaging')
for(const path of source){if(path.startsWith('.github/'))continue;await mkdir(dirname(join(kit,path)),{recursive:true});await cp(join(root,path),join(kit,path))}
await mkdir(join(kit,'release-input'))
const release=await assembleUiRelease({artifactsDir:join(inputs,'artifacts'),startupDir:join(inputs,'startup'),legacyDir:join(inputs,'legacy'),webDir:join(root,'packages/web/dist'),outputDir:join(kit,'release-input/web')})
await verifyUiRelease(join(kit,'release-input/web'))
const commit=execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim()
await writeFile(join(kit,'manifest.json'),JSON.stringify({schema:1,version:pkg.version,source:commit,buildSources:source},null,2)+'\n')
run('tar',['-czf',join(output,kitName+'.tar.gz'),'-C',output,kitName])
const nativeName=`dsh-web-control-native-inputs-${pkg.version}.tar.gz`
run('tar',['-czf',join(output,nativeName),'-C',inputs,'artifacts','startup','legacy'])
const assets=[]
for(const name of [`dsh-web-control-${pkg.version}.tgz`,`${kitName}.tar.gz`,nativeName]){
 const bytes=await readFile(join(output,name));assets.push({name,bytes:bytes.length,sha256:hash(bytes)})
}
await writeFile(join(output,'release-manifest.json'),JSON.stringify({schema:1,version:pkg.version,source:commit,dshVersion:'0.2.0-rc.2',uiRevision:release.native[0].revision,artifacts:assets,verification:'See release notes for commands actually executed; this manifest alone is not a test result.'},null,2)+'\n')
assets.push({name:'release-manifest.json',sha256:hash(await readFile(join(output,'release-manifest.json')))})
await writeFile(join(output,'SHA256SUMS'),assets.map(a=>a.sha256+'  '+a.name).join('\n')+'\n')
console.log(JSON.stringify({directory:output,version:pkg.version,artifacts:assets.map(a=>a.name)}))
