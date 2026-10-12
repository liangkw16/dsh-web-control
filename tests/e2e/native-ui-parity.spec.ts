import {test,expect,nativeInput} from './native-ui-fixtures.ts'
for(const target of ['local','remote'] as const)test(`original ${target} question custom answer and historical tool ordering`,async({nativePage,localPage,nativeFixture})=>{
  const page=target==='local'?localPage:nativePage
  if(target==='local'){
    await expect.poll(()=>nativePage.evaluate(()=>!!(globalThis as any).__nativeFixtureOwner__)).toBe(true)
    await nativePage.evaluate(async()=>{await (globalThis as any).__nativeFixtureOwner__.dispose()})
    await page.getByRole('dialog',{name:'预览版说明'}).getByRole('button',{name:'继续',exact:true}).click()
  }
  await nativeFixture.scenario('questions')
  await page.getByRole('treeitem',{name:/Native UI verification/}).click()
  await expect(page.getByText('Native UI seeded history',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:/^已完成/}).click()
  await page.getByRole('button',{name:'已调用工具',exact:true}).click()
  await page.getByRole('button',{name:/^工具调用 native_ui_history/}).click()
  await expect(page.getByText('Native historical tool output',{exact:true})).toBeVisible()
  await nativeInput(page).fill('Question custom input');await nativeInput(page).press('Enter')
  await page.getByRole('button',{name:'允许一次',exact:true}).click()
  await expect(page.getByText('选择验证方案',{exact:true})).toBeVisible()
  await expect.poll(()=>nativeFixture.pendingInteractions()).toBe(1)
  const custom=page.getByPlaceholder(/其他|自定义|输入/)
  await custom.fill('自定义的验证方案')
  await page.getByRole('button',{name:'提交',exact:true}).click()
  await expect.poll(()=>nativeFixture.status()).toMatchObject({questionAnswer:{answers:[{id:'choice',selected:[],custom:'自定义的验证方案'}]},pendingInteractions:0})
  await page.getByRole('button',{name:'停止生成',exact:true}).click()
})

for(const winner of ['local','remote'] as const)test(`${winner} answers once while both original pages observe the same task`,async({nativePage,localPage,nativeFixture})=>{
  await localPage.getByRole('dialog',{name:'预览版说明'}).getByRole('button',{name:'继续',exact:true}).click()
  await localPage.getByRole('treeitem',{name:/Native UI verification/}).click()
  await nativePage.getByRole('treeitem',{name:/Native UI verification/}).click()
  const page=winner==='local'?localPage:nativePage,other=winner==='local'?nativePage:localPage
  // The original public waterfall selects a connected client; reconnect the chosen
  // surface before the synthetic request, without changing any Host handler.
  await page.reload()
  await page.getByRole('treeitem',{name:/Native UI verification/}).click()
  await nativeInput(page).fill('Only one native answer');await nativeInput(page).press('Enter')
  await page.getByRole('button',{name:'允许一次',exact:true}).click()
  await expect.poll(()=>nativeFixture.status()).toMatchObject({starts:1,stops:0,approvals:1,pendingInteractions:0,prompts:1})
  await expect(other.getByRole('button',{name:'允许一次',exact:true})).toBeHidden()
  await expect(other.getByText('Native UI fixture output',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:'停止生成',exact:true}).click()
})

for(const target of ['local','remote'] as const)test(`${target} native history pages preserve order, failure detail and scroll anchor`,async({nativePage,localPage,nativeFixture})=>{
  const page=target==='local'?localPage:nativePage
  if(target==='local'){await expect.poll(()=>nativePage.evaluate(()=>!!(globalThis as any).__nativeFixtureOwner__)).toBe(true);await nativePage.evaluate(async()=>{await (globalThis as any).__nativeFixtureOwner__.dispose()});await localPage.getByRole('dialog',{name:'预览版说明'}).getByRole('button',{name:'继续',exact:true}).click()}
  await nativeFixture.seedHistory()
  await page.getByRole('treeitem',{name:/Native UI verification/}).click()
  await expect(page.getByText('History question 81',{exact:true})).toBeVisible()
  await page.getByRole('button',{name:/^已完成/}).last().click()
  await page.getByRole('button',{name:'已调用工具',exact:true}).last().click()
  await page.getByRole('button',{name:'工具调用 Synthetic tool failure',exact:true}).click()
  await expect(page.getByText('Synthetic tool failure',{exact:true})).toHaveCount(2)
  await expect(page.getByText('Synthetic tool failure',{exact:true}).last()).toBeVisible()
  const older=page.getByRole('button',{name:'加载更早',exact:true})
  await older.scrollIntoViewIfNeeded()
  const before=await page.getByText(/^History question \d+$/).allTextContents(),anchor=page.getByText(before[0],{exact:true})
  await anchor.scrollIntoViewIfNeeded();const y=(await anchor.boundingBox())!.y
  await older.click()
  await expect.poll(async()=>(await page.getByText(/^History question \d+$/).allTextContents()).length).toBeGreaterThan(before.length)
  const after=await page.getByText(/^History question \d+$/).allTextContents(),numbers=after.map(t=>Number(t.split(' ').at(-1)))
  expect(numbers).toEqual([...numbers].sort((a,b)=>a-b));expect(new Set(numbers).size).toBe(numbers.length)
  expect(Math.abs((await anchor.boundingBox())!.y-y)).toBeLessThan(50)
  expect(await nativeFixture.counts(nativeFixture.sessionId)).toEqual({starts:0,stops:0,prompts:0})
})


test('native long-turn duration, usage and recorded reminder match the original transcript',async({nativePage,localPage,nativeFixture})=>{
  await nativeFixture.seedArtifacts()
  await localPage.getByRole('dialog',{name:'预览版说明'}).getByRole('button',{name:'继续',exact:true}).click()
  await localPage.getByRole('treeitem',{name:/Native UI verification/}).click()
  await nativePage.getByRole('treeitem',{name:/Native UI verification/}).click()
  await expect(nativePage.getByText('Native long turn complete',{exact:true})).toBeVisible()
  await expect(nativePage.getByRole('button',{name:/已完成，用时/}).last()).toBeVisible()
  await expect(nativePage.getByText(/用量 7.7K tok/)).toBeVisible()
  await expect(localPage.getByText(/用量 7.7K tok/)).toBeVisible()
  await expect(localPage.locator('[data-turn-tail] [data-tool="schedule_create"]')).toContainText('Native recorded reminder')
  await expect(nativePage.locator('[data-turn-tail] [data-tool="schedule_create"]')).toContainText('Native recorded reminder')
  await nativePage.locator('[data-turn-tail] [data-tool="schedule_create"]').getByRole('button',{name:'打开',exact:true}).click()
  await expect(nativePage.getByText('Read-only recorded instruction',{exact:true})).toBeVisible()
  await nativeFixture.disconnectRemote()
  await expect(nativePage.getByRole('status',{name:'连接状态'})).toContainText('连接中断')
  await nativeFixture.restoreRemote()
  await expect(nativePage.getByRole('status',{name:'连接状态'})).toContainText('已连接')
  await expect(nativePage.getByText('Read-only recorded instruction',{exact:true})).toHaveCount(0)
  await expect(nativePage.getByText('连接已更新，请从对话中的自动化卡片重新打开记录。',{exact:true})).toBeVisible()
  await nativePage.locator('[data-turn-tail] [data-tool="schedule_create"]').getByRole('button',{name:'打开',exact:true}).click()
  await expect(nativePage.getByText('Read-only recorded instruction',{exact:true})).toBeVisible()
  expect(await nativeFixture.counts(nativeFixture.sessionId)).toEqual({starts:0,stops:0,prompts:0})
})
