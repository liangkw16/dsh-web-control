import {expect,test} from 'vitest'
import {nativeResourceFingerprint,verifyCandidate} from '../../scripts/native-ui-candidate.mjs'
import {mkdtemp,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
test('only the profile-owned top graph revision may differ between isolated native runs',()=>{
 const stock={schema:1,dshVersion:'0.2.0-rc.2',revision:'profile-a',graphPath:'graph.json',assets:[{path:'graph.json',sha256:'a',bytes:5},{path:'boot-injections.json',sha256:'b',bytes:7},{path:'business.js',sha256:'immutable',bytes:10}]}
 const graph={rev:'profile-a',entries:[{id:'conversation',url:'plugins/conversation.js?rev=pinned'}],batches:[]},injections=[{kind:'script',text:'trusted facade'},{kind:'global',name:'__DSH_BOOT__',value:graph}]
 const fingerprint=nativeResourceFingerprint(stock,{entry:'startup.js',assets:[{sha256:'pinned'}]},graph,injections)
 const other=structuredClone({stock,graph,injections});other.stock.revision='profile-b';other.stock.assets[0].sha256='different-manifest';other.stock.assets[1].bytes=999;other.graph.rev='profile-b';other.injections[1].value!.rev='profile-b'
 expect(nativeResourceFingerprint(other.stock,{entry:'startup.js',assets:[{sha256:'pinned'}]},other.graph,other.injections)).toBe(fingerprint)
 other.graph.entries[0].url='plugins/another.js';expect(nativeResourceFingerprint(other.stock,{entry:'startup.js',assets:[{sha256:'pinned'}]},other.graph,other.injections)).not.toBe(fingerprint)
 other.graph=graph;other.injections[0].text='changed script';expect(nativeResourceFingerprint(other.stock,{entry:'startup.js',assets:[{sha256:'pinned'}]},other.graph,other.injections)).not.toBe(fingerprint)
})
test('an incomplete or invented candidate cannot pass integrity verification',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'native-candidate-'))
 try{const path=join(dir,'manifest.json');await writeFile(path,JSON.stringify({schema:1,status:'PASS'}));await expect(verifyCandidate(path)).rejects.toThrow('Invalid candidate manifest')}finally{await rm(dir,{recursive:true,force:true})}
})
