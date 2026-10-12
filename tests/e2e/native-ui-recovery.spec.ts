import {test,expect,nativeInput} from './native-ui-fixtures.ts'
test('physical disconnect recovers streams and draft without taking over or restarting the task',async({nativePage,nativeFixture})=>{
  await nativeFixture.seedRunning()
  await nativeInput(nativePage).fill('Draft kept offline')
  await nativeFixture.disconnectRemote()
  await expect(nativePage.getByRole('status',{name:'连接状态'})).toContainText('连接中断')
  expect(await nativePage.locator('#root').evaluate(el=>(el as HTMLElement).inert)).toBe(true)
  await nativeFixture.restoreRemote()
  await expect(nativePage.getByRole('status',{name:'连接状态'})).toContainText('已连接')
  await expect(nativeInput(nativePage)).toHaveText('Draft kept offline')
  expect(await nativeFixture.counts(nativeFixture.sessionId)).toEqual({starts:1,stops:0,prompts:1})
  await nativeInput(nativePage).press('Enter')
  await expect.poll(async()=>(await nativeFixture.status()).inbox.nextTurn.length).toBe(1)
  await nativePage.getByRole('button',{name:'停止生成',exact:true}).click()
})

test('an accepted prompt with a lost acknowledgement reconciles once after physical recovery',async({nativePage,nativeFixture})=>{
  await nativeFixture.seedRunning()
  await nativePage.evaluate(()=>{(globalThis as any).__nativeFixtureFaults__.dropPromptAck=true})
  await nativeInput(nativePage).fill('One queued prompt');await nativeInput(nativePage).press('Enter')
  await expect.poll(()=>nativePage.evaluate(()=>(globalThis as any).__nativeFixtureCalls__.some((v:any)=>v.op==='rpc:session/prompt'&&v.outcome.includes('RESULT_UNCERTAIN')))).toBe(true)
  await nativeFixture.disconnectRemote();await expect(nativePage.getByRole('status',{name:'连接状态'})).toContainText('连接中断')
  await nativeFixture.restoreRemote();await nativePage.bringToFront()
  await expect(nativePage.getByRole('status',{name:'连接状态'})).toContainText('已连接')
  const result=await nativePage.evaluate(()=>(globalThis as any).__nativeFixtureRetryPrompt__())
  expect(result).toMatchObject({ok:true,value:{accepted:true}})
  expect(await nativeFixture.counts(nativeFixture.sessionId)).toEqual({starts:1,stops:0,prompts:2})
  expect((await nativeFixture.status()).inbox.nextTurn).toHaveLength(1)
})

test('a slow real transfer does not block original approval or the finite stop channel',async({nativePage,nativeFixture})=>{
  await nativePage.getByRole('treeitem',{name:/Native UI verification/}).click()
  await nativeInput(nativePage).fill('Approval during transfer');await nativeInput(nativePage).press('Enter')
  await expect(nativePage.getByRole('button',{name:'允许一次',exact:true})).toBeVisible()
  await nativePage.evaluate(()=>{(globalThis as any).__nativeFixtureFaults__.holdUploads()})
  try{
    await nativePage.locator('input[type=file]').setInputFiles({name:'slow.txt',mimeType:'text/plain',buffer:Buffer.alloc(512*1024,65)})
    await expect.poll(()=>nativePage.evaluate(()=>(globalThis as any).__nativeFixtureFaults__.uploadWaiting)).toBe(true)
    await nativePage.getByRole('button',{name:'允许一次',exact:true}).click()
    await expect.poll(()=>nativeFixture.status()).toMatchObject({approvals:1,pendingInteractions:0})
    // The stock composer replaces its stop button while a file is pending. Exercise
    // the public RPC contract here to verify transport concurrency; button parity is
    // checked separately, with no override of the published UI's input policy.
    const stopped=await nativePage.evaluate(sessionId=>(globalThis as any).__DSH_TRANSPORT__.rpc.call('/api','session/cancel',{args:{request:{sessionId}}}),nativeFixture.sessionId)
    expect(stopped).toMatchObject({ok:true})
    await expect.poll(()=>nativeFixture.counts(nativeFixture.sessionId)).toEqual({starts:1,stops:1,prompts:1})
  }finally{await nativePage.evaluate(()=>{(globalThis as any).__nativeFixtureFaults__.releaseUploads()})}
})

test('switching session during a pending upload cancels its captured authority',async({nativePage,nativeFixture})=>{
  await nativeFixture.seedRunning()
  await nativePage.evaluate(()=>{(globalThis as any).__nativeFixtureFaults__.holdUploads()})
  try{
    await nativePage.locator('input[type=file]').setInputFiles({name:'switch.txt',mimeType:'text/plain',buffer:Buffer.alloc(512*1024,65)})
    await expect.poll(()=>nativePage.evaluate(()=>(globalThis as any).__nativeFixtureFaults__.uploadWaiting)).toBe(true)
    await nativePage.getByRole('button',{name:'新建会话',exact:true}).first().click()
    await nativePage.evaluate(()=>{(globalThis as any).__nativeFixtureFaults__.releaseUploads()})
    await expect.poll(()=>nativePage.evaluate(()=>(globalThis as any).__nativeFixtureCalls__.some((v:any)=>v.op==='upload'&&v.outcome==='ProtocolError: TRANSFER_CLOSED'))).toBe(true)
    expect(await nativeFixture.counts(nativeFixture.sessionId)).toEqual({starts:1,stops:0,prompts:1})
  }finally{await nativePage.evaluate(()=>{(globalThis as any).__nativeFixtureFaults__.releaseUploads()})}
})

test('replaced and disconnected pages cannot mutate the original queue even outside the UI block',async({nativePage,nativeFixture})=>{
  await nativeFixture.seedRunning()
  await nativeInput(nativePage).fill('Keep this queue item');await nativeInput(nativePage).press('Enter')
  await expect.poll(async()=>(await nativeFixture.status()).inbox.nextTurn.length).toBe(1)
  const item=(await nativeFixture.status()).inbox.nextTurn[0]
  const replacement=await nativeFixture.openRemote()
  await expect(nativePage.getByRole('status',{name:'连接状态'})).toContainText('已在其他页面接管')
  const remove=async(page:typeof nativePage)=>page.evaluate(({sessionId,itemId})=>(globalThis as any).__DSH_TRANSPORT__.rpc.call('/api','session/updateQueue',{args:{request:{sessionId,itemId,action:{kind:'remove'}}}}),{sessionId:nativeFixture.sessionId,itemId:item.id})
  expect(await remove(nativePage)).toMatchObject({ok:false})
  await replacement.getByRole('treeitem',{name:/Native UI verification/}).click()
  await expect(replacement.getByRole('status',{name:'连接状态'})).toContainText('已连接')
  await nativeFixture.disconnectRemote()
  await expect(replacement.getByRole('status',{name:'连接状态'})).toContainText('连接中断')
  expect(await remove(replacement)).toMatchObject({ok:false})
  expect((await nativeFixture.status()).inbox.nextTurn).toEqual([item])
  expect(await nativeFixture.counts(nativeFixture.sessionId)).toEqual({starts:1,stops:0,prompts:2})
})
