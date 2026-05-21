import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ralphRunDir } from "./workflow-registry.js";

// Creates the run's memory dir and a self-contained .gitignore that ignores the
// entire .ai-whisper/ subtree — without touching the user's root .gitignore or
// any tracked file. Idempotent.
export function ensureRalphWorkspace(workspaceRoot: string, workflowId: string): string {
	const dir = ralphRunDir(workspaceRoot, workflowId);
	mkdirSync(dir, { recursive: true });
	const ignorePath = join(workspaceRoot, ".ai-whisper", ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "*\n");
	}
	return dir;
}
