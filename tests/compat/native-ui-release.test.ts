import {test,expect} from 'vitest'
import {mkdtemp,mkdir,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join,resolve} from 'node:path'
import {createHash} from 'node:crypto'
import {assembleUiRelease} from '../../scripts/native-ui-resources.mjs'
import {verifyUiRelease} from '../../packages/relay/src/ui-assets.ts'
const sha=(v:string|Buffer)=>createHash('sha256').update(v).digest('hex')
test('assembles fixed version resources and byte-identical legacy with exact query inventory',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-release-'))
 try{
  const artifactsDir=join(dir,'stock'),startupDir=join(dir,'startup'),webDir=join(dir,'web'),outputDir=join(dir,'release')
  for(const path of [artifactsDir,startupDir,webDir])await mkdir(path)
  const stockFiles={'index.html':'<html>stock</html>','graph.json':'{}','boot-injections.json':JSON.stringify([{kind:'script',text:'/* pinned facade */'}]),'license.txt':'MIT','chunk.js':'/* unchanged business */'},assets=[]
  for(const[path,bytes]of Object.entries(stockFiles)){await writeFile(join(artifactsDir,path),bytes);assets.push({path,sha256:sha(bytes),bytes:Buffer.byteLength(bytes),sourcePackage:'@deepseek-ai/dsh-web-frontend',sourceVersion:'0.2.0-rc.2',...(path==='chunk.js'?{url:'plugins/??example/client.js&rev=old'}:{})})}
  await writeFile(join(artifactsDir,'manifest.json'),JSON.stringify({schema:1,dshVersion:'0.2.0-rc.2',revision:'a'.repeat(64),entryHtml:'index.html',graphPath:'graph.json',licenses:['license.txt'],assets}))
  await writeFile(join(startupDir,'entry.js'),'/* remote startup */')
  await writeFile(join(startupDir,'manifest.json'),JSON.stringify({schema:1,dshVersion:'0.2.0-rc.2',entry:'entry.js',assets:[{path:'entry.js',sha256:sha('/* remote startup */'),bytes:20}],styles:[]}))
  await writeFile(join(webDir,'index.html'),'<meta name="dsh-ui-release" content="1"><script src="/entry.js"></script>');await writeFile(join(webDir,'entry.js'),'/* remote owner */')
  const release=await assembleUiRelease({artifactsDir,startupDir,webDir,outputDir,legacyDir:resolve('tests/fixtures/legacy-release')})
  await verifyUiRelease(outputDir)
  const revision=release.native[0].revision
  expect(release.assets.find(a=>a.url===`/ui/${revision}/plugins/??example/client.js&rev=old`)?.sha256).toBe(sha(stockFiles['chunk.js']))
  expect(await readFile(join(outputDir,release.legacy.html),'utf8')).toBe(await readFile('tests/fixtures/legacy-release/web/index.html','utf8'))
  expect(release.inlineScripts).toContain('sha256-'+createHash('sha256').update('/* pinned facade */').digest('base64'))
  await writeFile(join(outputDir,`ui/${revision}/chunk.js`),'tampered');await expect(verifyUiRelease(outputDir)).rejects.toThrow()
  await expect(assembleUiRelease({artifactsDir,startupDir,webDir,outputDir,legacyDir:resolve('tests/fixtures/legacy-release')})).rejects.toThrow()
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('refuses an unknown frozen legacy artifact before publishing a release',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-release-bad-'))
 try{await writeFile(join(dir,'manifest.json'),'{}');await expect(assembleUiRelease({legacyDir:dir,artifactsDir:dir,startupDir:dir,webDir:dir,outputDir:join(dir,'out')})).rejects.toThrow(/Frozen legacy/)}finally{await rm(dir,{recursive:true,force:true})}
})
