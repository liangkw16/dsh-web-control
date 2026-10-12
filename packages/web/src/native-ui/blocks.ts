interface Block { reason:string }
interface Registry { set(id:string,value:Block|undefined):void;storeFor(id:string):{getSnapshot():Block|undefined} }
/** Public ComposerBlocks plus inert root cover editor, buttons, file intake and portals' RPC guards. */
export class NativeBlocks {
  private readonly owned=new Map<string,{mine:Block;previous:Block|undefined}>()
  constructor(private readonly root:{inert:boolean},private readonly registry:Registry){}
  update(ids:readonly string[],ready:boolean,reason:string):void{
    this.root.inert=!ready
    for(const[id,value]of this.owned)if(ready||!ids.includes(id)){if(this.registry.storeFor(id).getSnapshot()===value.mine)this.registry.set(id,value.previous);this.owned.delete(id)}
    if(!ready)for(const id of ids){
      const old=this.owned.get(id);if(old?.mine.reason===reason)continue
      const previous=old?old.previous:this.registry.storeFor(id).getSnapshot(),mine={reason}
      this.owned.set(id,{mine,previous});this.registry.set(id,mine)
    }
  }
  dispose():void{this.update([],true,'')}
}
