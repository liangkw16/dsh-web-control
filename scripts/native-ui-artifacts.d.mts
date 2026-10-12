export interface UiArtifact {
  path: string; sha256: string; bytes: number; sourcePackage: string; sourceVersion: string;
  /** Exact document-relative request, including revisioned combo query. */
  url?: string;
  sources?: { name: string; version: string }[];
}
export interface UiArtifactManifest {
  schema: 1; dshVersion: '0.2.0-rc.2'; revision: string;
  entryHtml: string; assets: UiArtifact[]; graphPath: string; licenses: string[];
}
export function validateArtifactPaths(paths: readonly string[]): void;
export function verifyUiArtifacts(root: string, manifest: UiArtifactManifest): Promise<void>;
export function collectUiArtifacts(options: {
  runtimeRoot: string; outputDir: string; fixtureOrigin: string; fetch: typeof fetch;
}): Promise<UiArtifactManifest>;
