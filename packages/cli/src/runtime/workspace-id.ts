import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

export function workspaceIdFromPath(workspaceRoot: string): string {
	const canonical = realpathSync(path.resolve(workspaceRoot));
	return createHash("sha256").update(canonical).digest("hex").slice(0, 16);
}

export function canonicalWorkspaceRoot(workspaceRoot: string): string {
	return realpathSync(path.resolve(workspaceRoot));
}
