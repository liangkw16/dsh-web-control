/** Test-only stock Host plugin, installed only into a new marked profile by native-ui-compat. */
import type { Context } from '@deepseek-ai/cordis'
import { bootInjections } from '@deepseek-ai/dsh-client-modules'
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session/types'
import { createRequire } from 'node:module'
import { mkdir, readFile, readdir, writeFile, unlink, symlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { MessageId } from '@deepseek-ai/dsh-llm/brand'
import type {} from '@deepseek-ai/dsh-app-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-api-gateway'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-user-approval'
import type {} from '@deepseek-ai/dsh-user-questions'

export const name = 'web-control-native-ui-fixture'
export const inject = ['clientModules', 'connection', 'profileContext', 'typertGateway', 'llm', 'sessions', 'sessionProjections', 'agents', 'approval', 'userQuestions', 'workspaceRegistry']
export function apply(ctx: Context) {
  const lifetime = new AbortController()
  ctx.effect(() => () => lifetime.abort())
  let sessionId: string | undefined
  let starts = 0, stops = 0, approvals = 0,pendingInteractions=0
  let scenario:'hold'|'questions'|'files'='hold',fileToolIssued=false,workspacePath=''
  let questionAnswer:unknown
  const prompts: { id: string; target: string; types: string[] }[] = []
  const seen = new Set<string>()
  ctx.on('session/event', (session, event) => {
    if (session.id !== sessionId || event.type !== 'agent/inbox/spliced') return
    for (const message of event.data.inserted) if (!seen.has(message.id)) { seen.add(message.id); prompts.push({ id: message.id, target: event.data.target, types: message.content.map(part => part.type) }) }
  })
  const invoke = (namespace: string, method: string, request: Record<string, unknown>) => ctx.typertGateway.invoke({ namespace, method, args: { request }, signal: lifetime.signal }) as Promise<any>
  const isolated = async () => {
    const marker = JSON.parse(await readFile(join(ctx.profileContext.dir, '.web-control-compat.json'), 'utf8'))
    if (marker.isolated !== true || marker.nativeUi !== true) throw new Error('Not an owned native UI fixture')
  }
  class Synthetic extends LlmAdapter {
    override async listModels(provider: string) { return [{ provider, id: 'synthetic', name: 'Native UI fixture', inputModalities: ['text', 'image'] as const }] }
    override async resolveModel(provider: string, id: string) { return { provider, id, name: 'Native UI fixture', inputModalities: ['text', 'image'] as const } }
    override async *stream(options: import('@deepseek-ai/dsh-llm').GenerateOptions): AsyncIterable<import('@deepseek-ai/dsh-llm').StreamChunk> {
      await isolated()
      if (options.purpose) { yield { type: 'finish', reason: { kind: 'stop' } }; return }
      const signal = AbortSignal.any([lifetime.signal, ...(options.signal ? [options.signal] : [])])
      starts++
      try {
        const agent = ctx.agents.get(SessionId(sessionId!)); if (!agent) throw new Error('Missing fixture session')
        if(scenario==='files'&&fileToolIssued){
          yield {type:'block-start',index:0,blockType:'text'}
          yield {type:'text-delta',index:0,text:'Native recorded file complete'}
          yield {type:'block-end',index:0,block:{type:'text',text:'Native recorded file complete'}}
          yield {type:'finish',reason:{kind:'stop'}};return
        }
        pendingInteractions++
        const decision = await ctx.approval.request({ agent, toolName: 'native-ui-fixture', reason: 'Synthetic UI verification', signal }).finally(()=>pendingInteractions--)
        if (decision === 'allowed-once') approvals++
        else { yield { type: 'finish', reason: { kind: 'stop' } }; return }
        if(scenario==='questions'){
          pendingInteractions++
          questionAnswer=await ctx.userQuestions.ask({agent,signal,questions:[{id:'choice',question:'选择验证方案',options:[{label:'方案 A'},{label:'方案 B'}]}]}).finally(()=>pendingInteractions--)
        }
        if(scenario==='files'){
          fileToolIssued=true
          for(let index=0;index<6;index++){
            const file=index===0?'native-recorded.txt':`native-recorded-${index+1}.txt`
            const id=ToolCallId(randomUUID()),args=JSON.stringify({file_path:join(workspacePath,file),content:`Native recorded diff content ${index+1}\n`})
            yield {type:'block-start',index,blockType:'tool-call'}
            yield {type:'tool-call-delta',index,id,name:'write',argumentsDelta:args}
            yield {type:'block-end',index,block:{type:'tool-call',id,name:'write',arguments:args}}
          }
          yield {type:'finish',reason:{kind:'tool-calls'}};return
        }
        yield { type: 'block-start', index: 0, blockType: 'text' }
        yield { type: 'text-delta', index: 0, text: 'Native UI fixture output' }
        await new Promise<void>(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', () => resolve(), { once: true }) })
        signal.throwIfAborted()
      } finally { stops++ }
    }
  }
  ctx.effect(() => ctx.llm.registerAdapter(['native-ui-fixture'], new Synthetic()))
  async function inventory() {
    await isolated()
    const installed = ctx.clientModules.graph()
    // The release inventory consists only of published DSH modules. Installed remote
    // management UI is deliberately excluded from the remote composition.
    const graph = { ...installed, entries: installed.entries.filter(row => row.id.startsWith('@deepseek-ai/')), batches: installed.batches.flatMap(row => row.entries.every(id => id.startsWith('@deepseek-ai/')) ? [row] : installed.entries.filter(entry => row.entries.includes(entry.id) && entry.id.startsWith('@deepseek-ai/')).map(entry => ({ phase: row.phase, url: entry.url, rev: entry.rev, entries: [entry.id] }))) }
    const resources = new Map<string, { url: string; packages: string[] }>()
    for (const row of graph.entries) {
      resources.set(row.url, { url: row.url, packages: [row.id] })
      const entry = ctx.clientModules.clientPath(row.id); if (!entry) throw new Error('Client artifact missing')
      for (const file of await readdir(dirname(entry))) {
        if (/^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/.test(file)) {
          const url = `plugins/${row.id}/${file}?rev=${row.rev}`
          resources.set(url, { url, packages: [row.id] })
        }
      }
    }
    for (const batch of graph.batches) resources.set(batch.url, { url: batch.url, packages: batch.entries })
    return { dshVersion: createRequire(import.meta.url)('@deepseek-ai/dsh/package.json').version as string, graph, injections: bootInjections(graph), resources: [...resources.values()] }
  }
  for (const method of ['inventory', 'bundle', 'setup', 'status', 'preference', 'scenario', 'history', 'artifacts', 'management', 'large', 'documents', 'revoke-files', 'file-boundary']) {
    ctx.connection.fetch.register({ path: `/api/web-control/native-ui/${method}`, methods: [method === 'inventory' || method === 'status' ? 'GET' : 'POST'], requestBody: 'buffered', async fetch(request) {
      await isolated()
      if (method === 'inventory') return Response.json(await inventory())
      if(method==='file-boundary'){
        if(!sessionId)throw new Error('Owned session missing')
        const outside=join(ctx.profileContext.dir,'owned-outside-file.txt')
        await writeFile(outside,'Owned upstream boundary proof')
        await symlink(outside,join(workspacePath,'linked.txt'))
        const upstream=await ctx.typertGateway.invoke({namespace:'workspaceFiles',method:'read',args:{workspaceFileScopeId:sessionId,path:outside,range:{}},signal:request.signal})
        return Response.json({outside,upstreamOutsideRead:JSON.stringify(upstream).includes('Owned upstream boundary proof')})
      }
      if(method==='revoke-files'){
        if(!sessionId)throw new Error('Owned session missing')
        const workspace=ctx.workspaceRegistry.list().find(w=>w.sessionIds.includes(SessionId(sessionId!)))
        if(!workspace)throw new Error('Owned workspace missing')
        await workspace.detachSession(SessionId(sessionId));return Response.json({ok:true})
      }
      if (method === 'large') {
        try {
        if (starts || !sessionId) throw new Error('Large projection seeding requires idle owned fixture')
        const require = createRequire(import.meta.url), z = createRequire(require.resolve('@deepseek-ai/dsh-session-projection'))('zod').z
        const payload = 'native-large-🚀'.repeat(70000)
        ctx.effect(() => ctx.sessionProjections.register({ key: 'nativeLargeFixture', stateVersion: 1, stateSchema: z.string(), init: (header: { id: string }) => header.id === sessionId ? payload : '', apply: (state: string) => state, wire: { viewSchema: z.string(), view: (state: string) => state } } as any))
        ctx.sessionProjections.snapshot(ctx.sessions.get(SessionId(sessionId))!)
        return Response.json({ bytes: Buffer.byteLength(payload) })
        } catch (error) { return Response.json({ error: String(error) }, { status: 500 }) }
      }
      if (method === 'bundle') {
        const body = await request.json() as { url?: unknown }
        const data = await inventory()
        if (!data.resources.some(row => row.url === body.url)) return new Response(null, { status: 404 })
        return ctx.clientModules.fetchBundle(new Request(new URL(body.url as string, new URL(request.url).origin)))
      }
      if(method==='management'){
        if(starts||!sessionId)throw new Error('Management seeding requires idle owned fixture')
        const ownedSessionId=SessionId(sessionId)
        const original=ctx.workspaceRegistry.list().find(w=>w.sessionIds.includes(ownedSessionId))!
        const peer=(await invoke('session','fork',{sessionId})).sessionId
        await invoke('session','rename',{sessionId:peer,title:'Ordered peer'})
        const path=join(ctx.profileContext.dir,'other-workspace');await mkdir(path)
        const workspace=(await invoke('workspace','create',{path})).workspace
        return Response.json({workspaceId:workspace.workspaceId,originalWorkspaceId:original.id,peer})
      }
      if(method==='documents'){
        const input=await request.json() as {files:Record<string,string|null>;update?:boolean}
        if(!sessionId||Object.keys(input.files).length>16)throw new Error('Invalid owned documents')
        if(!input.update&&starts)throw new Error('Document seeding requires idle fixture')
        for(const [name,data] of Object.entries(input.files)){
          if(name.split('/').some(part=>!/^[a-zA-Z0-9_.-]+$/.test(part)||part==='.'||part==='..'))throw new Error('Invalid owned filename')
          if(data===null)await unlink(join(workspacePath,name))
          else { await mkdir(join(workspacePath,name,'..'),{recursive:true}); await writeFile(join(workspacePath,name),Buffer.from(data,'base64')) }
        }
        if(!input.update){
          const session=ctx.sessions.get(SessionId(sessionId))!,turn=2,callId=ToolCallId(randomUUID())
          session.append('user/message',{id:MessageId(randomUUID()),role:'user',source:{kind:'user'},content:[{type:'text',text:'Preview these owned documents'}]},{surfaceOp:'append'})
          session.append('turn/start',{turn});session.append('step/start',{turn,step:0})
          session.append('deliverables/presented' as any,{turn,callId,files:Object.keys(input.files).map(path=>({path,description:'Owned preview fixture'}))} as any)
          session.append('assistant/message',{turn,step:0,stream:[],message:{id:MessageId(randomUUID()),role:'assistant',source:{kind:'model',provider:'native-ui-fixture',model:'synthetic'},content:[{type:'text',text:'Native document fixtures ready'}]}},{surfaceOp:'append'})
          session.append('step/end',{turn,step:0});session.append('turn/end',{turn,reason:{kind:'completed'}})
          await ctx.parallel('session/flush',session)
        }
        return Response.json({ok:true})
      }
      if(method==='artifacts'){
        if(starts||!sessionId)throw new Error('Artifact seeding requires idle owned fixture')
        const session=ctx.sessions.get(SessionId(sessionId))!
        session.append('user/message',{id:MessageId(randomUUID()),role:'user',source:{kind:'user'},content:[{type:'text',text:'Recorded artifact parity'}]},{surfaceOp:'append'})
        session.append('turn/start',{turn:2})
        for(let step=0;step<70;step++){
          session.append('step/start',{turn:2,step})
          session.append('assistant/message',{turn:2,step,stream:[],usage:{inputTokens:100,outputTokens:10,totalTokens:110},message:{id:MessageId(randomUUID()),role:'assistant',source:{kind:'model',provider:'native-ui-fixture',model:'synthetic'},content:[{type:'text',text:step===69?'Native long turn complete':'History padding '+step+' '+ 'x'.repeat(5000)}]}},{surfaceOp:'append'})
          if(step===69){
            const callId=ToolCallId(randomUUID())
            session.append('tool/call',{turn:2,step,callId,name:'schedule_create',arguments:'{}'})
            session.append('tool/result',{turn:2,step,message:{id:MessageId(randomUUID()),role:'tool',source:{kind:'tool',callId},toolCallId:callId,content:[{type:'text',text:JSON.stringify({id:'fixture-task',kind:'at',title:'Native recorded reminder',prompt:'Read-only recorded instruction',scheduledAt:'2030-01-01T12:00:00.000Z'})}]}},{surfaceOp:'append'})
          }
          session.append('step/end',{turn:2,step})
        }
        session.append('turn/end',{turn:2,reason:{kind:'completed'}})
        await ctx.parallel('session/flush',session);return Response.json({ok:true})
      }
      if(method==='history'){
        if(starts||!sessionId)throw new Error('History seeding requires idle owned fixture')
        const session=ctx.sessions.get(SessionId(sessionId))!
        for(let turn=2;turn<=81;turn++){
          session.append('user/message',{id:MessageId(randomUUID()),role:'user',source:{kind:'user'},content:[{type:'text',text:`History question ${turn}`}]},{surfaceOp:'append'})
          session.append('turn/start',{turn});session.append('step/start',{turn,step:0})
          const callId=ToolCallId(randomUUID())
          session.append('assistant/message',{turn,step:0,stream:[],message:{id:MessageId(randomUUID()),role:'assistant',source:{kind:'model',provider:'native-ui-fixture',model:'synthetic'},content:[{type:'tool-call',id:callId,name:'native_history_check',arguments:'{}'}]}},{surfaceOp:'append'})
          session.append('tool/call',{turn,step:0,callId,name:'native_history_check',arguments:'{}'})
          session.append('tool/result',{turn,step:0,message:{id:MessageId(randomUUID()),role:'tool',source:{kind:'tool',callId},toolCallId:callId,isError:turn===81,content:[{type:'text',text:turn===81?'Synthetic tool failure':`History result ${turn}`}]}},{surfaceOp:'append'})
          session.append('step/end',{turn,step:0});session.append('turn/end',{turn,reason:{kind:'completed'}})
        }
        await ctx.parallel('session/flush',session);return Response.json({ok:true})
      }
      if(method==='scenario'){
        const input=await request.json() as {scenario?:unknown}
        if(starts||!['questions','files'].includes(String(input.scenario)))return Response.json({error:'invalid scenario'},{status:400})
        scenario=input.scenario as 'questions'|'files';return Response.json({ok:true})
      }
      if (method === 'status') { const agent = sessionId ? ctx.agents.get(SessionId(sessionId)) : undefined; return Response.json({ workspaces:ctx.workspaceRegistry.list().map(w=>({workspaceId:w.id,title:w.title,sessionIds:w.sessionIds})), archived:ctx.workspaceRegistry.archivedSessionIds,pinned:ctx.workspaceRegistry.pinnedSessionIds, starts, stops, approvals, questionAnswer,pendingInteractions, prompts: prompts.length, modes: prompts.map(p => p.target), contentTypes: prompts.map(p => p.types), inbox: agent ? { nextTurn: agent.inbox.nextTurn, nextStep: agent.inbox.nextStep } : null }) }
      if (method === 'preference') {
        const input = await request.text(); const mode = input ? JSON.parse(input).mode : 'steer'
        if (mode !== 'queue' && mode !== 'steer') return Response.json({ error: 'invalid mode' }, { status: 400 })
        const value = await ctx.typertGateway.invoke({ namespace: 'settings', method: 'mutate', args: { ns: 'ui-conversation', ops: [{ op: 'set', path: ['busyEnter'], value: mode }] } })
        return Response.json(value)
      }
      if (sessionId) throw new Error('Fixture setup is single-use')
      const path = join(ctx.profileContext.dir, 'native-ui-workspace');workspacePath=path; await mkdir(path)
      const workspaceId = (await invoke('workspace', 'create', { path })).workspace.workspaceId
      sessionId = (await invoke('session', 'create', { workspaceId })).sessionId
      await invoke('session', 'selectModel', { sessionId, provider: 'native-ui-fixture', model: 'synthetic' })
      await invoke('session', 'rename', { sessionId, title: 'Native UI verification' })
      const session = ctx.sessions.get(SessionId(sessionId!)); if (!session) throw new Error('Missing fixture session')
      session.append('user/message', { id: MessageId(randomUUID()), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'Native UI seeded history' }] }, { surfaceOp: 'append' })
      const callId = ToolCallId(randomUUID())
      session.append('turn/start', { turn: 1 })
      session.append('step/start', { turn: 1, step: 0 })
      session.append('assistant/message', { turn: 1, step: 0, stream: [], message: { id: MessageId(randomUUID()), role: 'assistant', source: { kind: 'model', provider: 'native-ui-fixture', model: 'synthetic' }, content: [{ type: 'tool-call', id: callId, name: 'native_ui_history', arguments: '{}' }] } }, { surfaceOp: 'append' })
      session.append('tool/call', { turn: 1, step: 0, callId, name: 'native_ui_history', arguments: '{}' })
      session.append('tool/result', { turn: 1, step: 0, message: { id: MessageId(randomUUID()), role: 'tool', source: { kind: 'tool', callId }, toolCallId: callId, content: [{ type: 'text', text: 'Native historical tool output' }] } }, { surfaceOp: 'append' })
      session.append('step/end', { turn: 1, step: 0 })
      session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
      await ctx.parallel('session/flush', session)
      return Response.json({ sessionId, workspaceId })
    } })
  }
}
