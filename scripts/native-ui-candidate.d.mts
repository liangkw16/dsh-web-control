export function nativeResourceFingerprint(artifacts:any,startup:any,graph:any,injections:any[]):string
export function verifyCandidate(manifestPath:string,options?:{sourceRoot?:string}):Promise<{manifest:any;directory:string}>
export function sourceInventory():Promise<{path:string;sha256:string}[]>
export function digestRows(rows:{path:string;sha256:string}[]):string
export function buildCandidate(options:{outputDir:string;artifactsDir:string;startupDir:string;legacyDir:string;platform?:string}):Promise<unknown>
