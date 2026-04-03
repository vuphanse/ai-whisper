import { resolve } from "node:path";

export function normalizeArtifactPaths(workspaceRoot: string, artifactPaths: string[]): string[] {
  return artifactPaths.map((path) => resolve(workspaceRoot, path));
}
