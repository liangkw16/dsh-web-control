import {test,expect} from 'vitest'
import {nativeGateCounts,validateNativeGateRuns} from '../../scripts/native-ui-gates.mjs'
test.each(['core','parity'] as const)('release rejects absent or duplicated current-file %s cases',stage=>{
 const required=stage==='core'?['native slow media initialization keeps the selected session synchronized','native current-file scope confines the actual public Host filesystem','native current documents use original renderers and preserve downloaded bytes','native file reload, deletion, cancellation and takeover preserve a running task'].map(test=>({browser:'chromium',test})):['chromium','webkit'].flatMap(browser=>[360,390,1280].map(width=>({browser,test:`original current-file preview and download at ${width} CSS pixels`})))
 const runs=[...required,...Array.from({length:nativeGateCounts[stage]-required.length},(_,i)=>({browser:'chromium',test:'other-'+i}))]
 expect(()=>validateNativeGateRuns(stage,runs)).not.toThrow()
 const exception={directive:'img-src',blocked:'https://example.invalid/private.png',source:'',line:0,sample:''}
 const attack=runs.map(run=>({...run,expectedSecurityCsp:run.test==='native current documents use original renderers and preserve downloaded bytes'?[exception]:[]}))
 expect(()=>validateNativeGateRuns(stage,attack)).not.toThrow()
 expect(()=>validateNativeGateRuns(stage,runs.map((run,index)=>({...run,expectedSecurityCsp:index===0?[exception]:[]})))).toThrow(/Unexpected security CSP/)
 expect(()=>validateNativeGateRuns(stage,runs.map((run,index)=>({...run,expectedSecurityCsp:index===1?[{...exception,directive:'script-src'}]:[]})))).toThrow(/Unexpected security CSP/)
 expect(()=>validateNativeGateRuns(stage,runs.slice(1))).toThrow(/Incomplete/)
 expect(()=>validateNativeGateRuns(stage,[{browser:'chromium',test:'replacement'},...runs.slice(1)])).toThrow(/Missing current-file/)
 expect(()=>validateNativeGateRuns(stage,[runs[1],...runs.slice(1)])).toThrow(/Duplicate/)
})
