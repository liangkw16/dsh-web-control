export function archiveIdentity(manifest:unknown,configBytes:string,candidate:any):string
export function deployRelease(options:{manifestPath:string;server:'relay-host';run?:(argv:string[])=>Promise<{code:number;stdout:string}>}):Promise<any>
export function rollbackRelease(options:{manifestPath:string;manifestSha256:string;server:'relay-host';run?:(argv:string[])=>Promise<{code:number;stdout:string}>}):Promise<any>
