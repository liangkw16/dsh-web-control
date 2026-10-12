import { NativeCleanup } from './cleanup.ts'
import { config as configureValidation } from 'zod/v4/core'
import { CURRENT_FILES_CAPABILITY, MANAGEMENT_CAPABILITY, ProtocolError, type SelectedUiProfile } from '../../../protocol/src/index.ts'
import type { BrowserTransport } from '../transport.ts'
import { DraftStore } from '../drafts.ts'
import { NativeDraftBinding } from './draft-binding.ts'
import { createNativeRpc } from './rpc-rc2.ts'
import { registerNativeExtension, nativePluginIds, nativeFilePluginIds } from './extension.ts'
import { NativePreferences } from './preferences.ts'
export interface UiArtifactManifest { schema:1;dshVersion:string;uiRevision:string;entryHtml:string;graphPath:string;assets:readonly {path:string;sha256:string;bytes:number;url?:string}[];startup:{entry:string;styles?:readonly string[]} }
export interface NativeUiInspection {loaders:number;react:number;cordis:number;roots:number;plugins:readonly string[]}
export interface NativeUiOwner { dispose():Promise<void>;inspection():NativeUiInspection }
/** Uses the published shell and its seed modules. No second React or Cordis runtime is imported. */
export async function bootNativeUi(options:{container:HTMLElement;instanceId:string;profile:SelectedUiProfile;transport:BrowserTransport;manifest:UiArtifactManifest;assetBase?:string;storage?:Storage;extensionUrl?:string}):Promise<NativeUiOwner>{
  const {container,instanceId,profile,transport,manifest}=options
  if(manifest.schema!==1||manifest.dshVersion!==profile.host.dshVersion||manifest.uiRevision!==profile.uiRevision||container.id!=='root')throw new ProtocolError('PROTOCOL_UNSUPPORTED')
  if(options.assetBase!==undefined&&options.assetBase!==`/ui/${profile.uiRevision}/`)throw new ProtocolError('PROTOCOL_UNSUPPORTED')
  const resource=(path:string)=>options.assetBase?new URL(path,new URL(options.assetBase,location.href)).href:path
  const globals=globalThis as any
  if(globals.__DSH_TRANSPORT__||globals.__ModuleLoader__)throw new ProtocolError('PROTOCOL_UNSUPPORTED')
  const preferences=new NativePreferences(transport,error=>transport.holdSync().fail(error))
  let storage:Storage;try{storage=options.storage??localStorage}catch{storage={getItem(){throw new Error('Storage unavailable')},setItem(){throw new Error('Storage unavailable')}} as unknown as Storage}
  const draftStore=new DraftStore(storage),drafts=new NativeDraftBinding(instanceId,draftStore)
  const rpc=createNativeRpc({transport,profile,submission:(sessionId,requestId)=>drafts.submission(sessionId,requestId),prepareGeneration:context=>preferences.begin(context.signal)})
  const unsubscribe=transport.registerSynchronizer(context=>rpc.begin(context))
  const mounted=Promise.withResolvers<void>(),configured=Promise.withResolvers<void>();void mounted.promise.catch(()=>{});void configured.promise.catch(()=>{})
  let releaseNative:(()=>Promise<void>)|undefined,bootRun:Promise<void>|undefined
  const startupLife=new AbortController()
  const inspection:NativeUiInspection={loaders:0,react:0,cordis:0,roots:0,plugins:[]}
  let seeds:Record<string,unknown>|undefined
  const cleanup=new NativeCleanup()
  cleanup.add(unsubscribe);cleanup.add(()=>preferences.dispose());cleanup.add(()=>drafts.dispose());cleanup.add(()=>rpc.dispose());cleanup.add(async()=>{try{await bootRun}catch{/* Startup failure is reported by the caller. */}await releaseNative?.()});cleanup.add(()=>transport.dispose());cleanup.add(()=>{delete globals.__DSH_FILE_UPLOAD__;delete globals.__DSH_TRANSPORT__;delete globals.__DSH_REMOTE_ENTRY__})
  const dispose=()=>{startupLife.abort(new ProtocolError('TRANSFER_CLOSED'));return cleanup.dispose()}
  try{
    // Zod's supported CSP mode also prevents its caught eval feature probe.
    configureValidation({jitless:true})
    container.dataset.dshRemote=''
    globals.__DSH_TRANSPORT__={rpc:rpc.rpc};globals.__DSH_FILE_UPLOAD__=rpc.fileUpload
    // AppWebEntry.run/dispose are public. Capture ownership before its asynchronous boot starts.
    globals.__DSH_REMOTE_ENTRY__={start(app:{run(failed:(reason:unknown)=>void):Promise<void>;dispose():Promise<void>}){
      if(bootRun)throw new Error('Duplicate native startup')
      releaseNative=()=>app.dispose()
      bootRun=app.run(reason=>{throw reason});void bootRun.catch(error=>mounted.reject(error))
    }}
    // Start the carrier before consumers; connect resolves only after their baselines.
    const connecting=transport.connect(instanceId);void connecting.catch(error=>mounted.reject(error))
    const injections=await(await fetch(resource('boot-injections.json'))).json() as any[]
    for(const row of injections){
      if(row.kind==='script'){const script=document.createElement('script');script.textContent=row.text;document.head.append(script)}
      else if(row.kind==='script-src')await loadScript(resource(row.src))
      else if(row.kind==='global'&&row.name==='__DSH_BOOT__')globals.__DSH_BOOT__=row.value
      else if(row.kind!=='script-preload')throw new ProtocolError('PROTOCOL_UNSUPPORTED')
    }
    registerNativeExtension({canFiles:profile.host.capabilities.includes(CURRENT_FILES_CAPABILITY),canManage:profile.host.capabilities.includes(MANAGEMENT_CAPABILITY),transport,rpc,preferences,instanceId,mounted,configured,drafts,draftStore,container,signal:startupLife.signal,verifyRuntime(require){
      if(!seeds||require('react')!==seeds.react||require('@deepseek-ai/cordis')!==seeds['@deepseek-ai/cordis'])throw new ProtocolError('PROTOCOL_UNSUPPORTED')
      inspection.react++;inspection.cordis++
    }})
    const graph=globals.__DSH_BOOT__;for(const row of [...graph.entries,...graph.batches])row.url=resource(row.url)
    const extensionUrl=options.extensionUrl??'entry.js'
    graph.entries.push({id:'dsh-remote-native',url:extensionUrl,rev:'rc2-native-1',inject:['@deepseek-ai/dsh-client-ui-conversation','@deepseek-ai/dsh-client-ui-renderer','@deepseek-ai/dsh-client-ui-settings','@deepseek-ai/dsh-client-ui-deliverables','@deepseek-ai/dsh-client-ui-schedule','@deepseek-ai/dsh-client-ui-workspace']});graph.batches.push({phase:'application',url:extensionUrl,rev:'rc2-native-1',entries:['dsh-remote-native']})
    const facade=globals.__ModuleLoader__,create=facade.create.bind(facade)
    facade.create=(args:{staticModules:Record<string,unknown>})=>{if(inspection.loaders++)throw new Error('Duplicate native loader');seeds=args.staticModules;const modules=create(args);modules.manifest={...modules.manifest,plugins:modules.manifest.plugins.filter((row:{id:string})=>nativePluginIds.has(row.id)||(profile.host.capabilities.includes(CURRENT_FILES_CAPABILITY)&&nativeFilePluginIds.has(row.id))||row.id==='dsh-remote-native')};inspection.plugins=Object.freeze(modules.manifest.plugins.map((row:{id:string})=>row.id));return modules}
    const shell=await(await fetch(resource('stock-shell.html'))).text(),html=new DOMParser().parseFromString(shell,'text/html')
    for(const link of html.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')){const node=document.createElement('link');node.rel='stylesheet';node.href=resource(link.getAttribute('href')!);document.head.append(node)}
    for(const path of manifest.startup.styles??[]){const node=document.createElement('link');node.rel='stylesheet';node.href=resource(path);document.head.append(node)}
    await loadScript(resource(manifest.startup.entry),'module')
    if(!bootRun)throw new Error('Native startup owner unavailable')
    await Promise.all([mounted.promise,configured.promise,bootRun,connecting])
    inspection.roots++
    return{dispose,inspection:()=>Object.freeze({...inspection})}
  }catch(error){await dispose();throw error}
}
function loadScript(src:string,type=''):Promise<void>{return new Promise((resolve,reject)=>{const script=document.createElement('script');script.src=src;if(type)script.type=type;script.onload=()=>resolve();script.onerror=()=>reject(new Error('Native UI resource failed'));document.head.append(script)})}
