/** Drain all resources even if a native disposer rejects. Every caller awaits one drain. */
export class NativeCleanup {
  private readonly releases:(()=>void|Promise<void>)[]=[]
  private draining?:Promise<void>
  add(release:()=>void|Promise<void>):void{this.releases.push(release)}
  dispose():Promise<void>{
    return this.draining??=(async()=>{
      const errors:unknown[]=[]
      for(const release of this.releases.splice(0))try{await release()}catch(error){errors.push(error)}
      if(errors.length)throw new AggregateError(errors,'Native UI cleanup failed')
    })()
  }
}
