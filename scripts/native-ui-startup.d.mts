export function cspLoaderSource(source:string):string;
export function inlineStyleHashes(source:string):string[];
export interface NativeStartupManifest {
  schema:number;dshVersion:string;entry:string;styles:string[];
  change:{package:string;version:string;sourceSha256:string;replacement:string};
  inputs:unknown[];assets:{path:string;bytes:number;sha256:string}[];licenses:unknown[];builderSha256:string;
}
export function buildNativeStartup(options:{runtimeRoot:string;outputDir:string}):Promise<NativeStartupManifest>;
