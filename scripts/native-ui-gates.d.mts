export const nativeGateCounts: {core:number;parity:number}
export function validateNativeGateRuns(stage:'core'|'parity',runs:unknown):void
export function reviewCodeDigest():Promise<string>
export function verifyRelease(manifestPath:string):Promise<any>
export function sealRelease(options:{candidateManifestPath:string;smokePath:string;reviewPath:string;outputPath:string}):Promise<any>
