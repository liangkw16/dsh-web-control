/** BFCache restores JS state, including disposed owners. Only a user gesture may reclaim. */
export function bindPageLifecycle(view:Window,container:HTMLElement,owner:Promise<{dispose():Promise<void>}>,reload:()=>void):()=>void{
 let disposing:Promise<void>|undefined
 const dispose=()=>disposing??=owner.then(value=>value.dispose()).catch(()=>{})
 const hide=()=>{void dispose()}
 const show=(event:PageTransitionEvent)=>{
  if(!event.persisted)return
  void dispose().then(()=>{
   const document=container.ownerDocument,card=document.createElement('section');card.className='remote-entry-message'
   const title=document.createElement('h1');title.textContent='页面已恢复'
   const message=document.createElement('p');message.textContent='连接已暂停。点击重新接管，继续查看会话；本机任务仍在运行。'
   const retry=document.createElement('button');retry.type='button';retry.textContent='重新接管';retry.onclick=reload
   card.append(title,message,retry);container.inert=false;container.replaceChildren(card)
  })
 }
 view.addEventListener('pagehide',hide,{once:true});view.addEventListener('pageshow',show)
 return()=>{view.removeEventListener('pagehide',hide);view.removeEventListener('pageshow',show)}
}
