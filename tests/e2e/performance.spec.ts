/** Scoped distribution: production UI/relay + deterministic public-contract fixture, not stock native. */
import { test, expect } from './fixtures.ts'
import { writeFile } from 'node:fs/promises'
import { browserEvidenceDirectories } from '../../scripts/evidence-paths.mjs'
const { performance: evidenceDir } = browserEvidenceDirectories()
type Sample = { loadingMs: number; recoveryMs: number; historyLoadMs: number; scrollMs: number; loadedRecords: number; pages: number; scrollHeight: number; finalScrollTop: number }
const n=3
for(const bps of [0,400000]) for(const width of [390,1280]) {
  test.describe(`${bps||'normal'}bps ${width}px`,()=>{
    test.use({performanceBps:bps,performanceRecords:192,viewport:{width,height:900}})
    test(`fixed browser performance distribution n=${n}`,async({connectedPage:page,browserNetwork,browser},info)=>{
      test.skip(info.project.name !== 'chromium', 'Owned CDP heap measurement is Chromium only')
      test.setTimeout(120000)
      const samples: Sample[]=[]
      const cdp=await page.context().newCDPSession(page)
      let heapPeak=0,rssPeak=process.memoryUsage().rss
      const heap=async()=>{const result=await cdp.send('Runtime.getHeapUsage'); heapPeak=Math.max(heapPeak,result.usedSize);rssPeak=Math.max(rssPeak,process.memoryUsage().rss)}
      for(let i=0;i<n;i++){
        // Session cookie retained, fresh page reload; HTTP cache disabled through owned CDP only.
        await cdp.send('Network.enable');await cdp.send('Network.setCacheDisabled',{cacheDisabled:true})
        const start=performance.now();await page.reload();await expect(page.getByRole('status',{name:'连接状态'})).toHaveText('已连接',{timeout:30000});await page.getByRole('textbox',{name:'消息',exact:true}).fill('performance retained draft');await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled()
        const loadingMs=performance.now()-start
        const reconnectStart=performance.now();await browserNetwork.disconnect();await expect(page.getByRole('button',{name:'发送',exact:true})).toBeDisabled();browserNetwork.resume();await expect(page.getByRole('status',{name:'连接状态'})).toHaveText('已连接',{timeout:30000});await expect(page.getByRole('button',{name:'发送',exact:true})).toBeEnabled()
        const recoveryMs=performance.now()-reconnectStart
        const timeline=page.getByLabel('会话消息',{exact:true});await timeline.evaluate(el=>{el.scrollTop=0})
        const historyStart=performance.now();let pages=0
        while(await page.getByRole('button',{name:'加载较早消息'}).count()) {
          const before=await timeline.locator('[data-message-id]').count();await page.getByRole('button',{name:'加载较早消息'}).click();pages++
          await expect.poll(()=>timeline.locator('[data-message-id]').count(),{timeout:30000}).toBeGreaterThan(before)
          expect(pages).toBeLessThanOrEqual(4)
        }
        await expect(page.getByText('performance-record-0 ',{exact:false})).toHaveCount(1)
        await expect(page.getByRole('status',{name:'连接状态'})).toHaveText('已连接')
        const loadedRecords=await timeline.locator('[data-message-id]').count();expect(loadedRecords).toBe(196)
        const historyLoadMs=performance.now()-historyStart
        const scroll=await timeline.evaluate(async el=>{const start=performance.now();for(let k=0;k<20;k++){el.scrollTop=(el.scrollHeight-el.clientHeight)*k/19;await new Promise<void>(r=>requestAnimationFrame(()=>r()))}return{ms:performance.now()-start,height:el.scrollHeight,finalTop:el.scrollTop}})
        await heap();samples.push({loadingMs,recoveryMs,historyLoadMs,scrollMs:scroll.ms,loadedRecords,pages,scrollHeight:scroll.height,finalScrollTop:scroll.finalTop})
      }
      const stats=(key:keyof typeof samples[number])=>{const values=samples.map(s=>Number(s[key])).sort((a,b)=>a-b);return{n:values.length,median:values[1],p95:values[2],min:values[0],max:values[2]}}
      await writeFile(`${evidenceDir}/${bps||'normal'}-${width}.json`,JSON.stringify({startedFrom:'owned authenticated cookie; cold HTTP reload per sample',engine:info.project.name,browser:browser.version(),width,height:900,bitsPerSecondPerDirection:bps,topology:'TLS terminator application plaintext shared uplink/downlink pacing; all HTTP and WSS traffic including fixture Host; excludes TLS handshake bytes',fixture:'192 appended +4 original records, production web dist/relay, deterministic public-contract Host',samples,distribution:{loadingMs:stats('loadingMs'),recoveryMs:stats('recoveryMs'),historyLoadMs:stats('historyLoadMs'),scrollMs:stats('scrollMs')},empiricalP95:'n=3 nearest-rank maximum; low sample count, not population estimate',heapPeakBytes:heapPeak,runnerRssPeakBytes:rssPeak,memoryScope:'JS heap sampled at completed scrolls via Runtime.getHeapUsage; runner RSS only, neither entire browser nor stock Host memory',finishedAt:new Date().toISOString()},null,2), {flag:'wx'})
      await cdp.detach()
    })
  })
}
