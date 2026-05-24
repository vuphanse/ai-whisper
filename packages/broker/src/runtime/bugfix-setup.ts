import { mkdirSync } from "node:fs";
import { bugfixRunDir } from "./workflow-registry.js";

/** Create the gitignored bugfix run dir for a workflow. Idempotent. Returns the dir. */
export function ensureBugfixWorkspace(
	workspaceRoot: string,
	workflowId: string,
): string {
	const dir = bugfixRunDir(workspaceRoot, workflowId);
	mkdirSync(dir, { recursive: true });
	return dir;
}
