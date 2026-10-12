export function verifyCandidate(manifestPath:string,options?:{sourceRoot?:string}):Promise<{manifest:any;directory:string}>
export function buildCandidate(options:{outputDir:string;artifactsDir:string;startupDir:string;legacyDir:string;platform?:'linux/amd64'|'linux/arm64'}):Promise<unknown>
export function deployRelease(options:{manifestPath:string;server:'relay-host';run?:(argv:string[])=>Promise<{code:number;stdout:string}>}):Promise<unknown>
export function rollbackRelease(options:{manifestPath:string;manifestSha256:string;server:'relay-host';run?:(argv:string[])=>Promise<{code:number;stdout:string}>}):Promise<unknown>
export function reviewCodeDigest():Promise<string>
export function verifyRelease(manifestPath:string):Promise<any>
export function sealRelease(options:{candidateManifestPath:string;smokePath:string;reviewPath:string;outputPath:string}):Promise<any>
