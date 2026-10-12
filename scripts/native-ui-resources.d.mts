import type {UiReleaseManifest} from '../packages/relay/src/ui-assets.ts'
export const frozenLegacy:{manifest:string;plugin:string}
export function assembleUiRelease(options:{artifactsDir:string;startupDir:string;webDir:string;legacyDir:string;outputDir:string}):Promise<UiReleaseManifest>
