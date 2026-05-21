import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ralphRunDir } from "./workflow-registry.js";

// Creates the run's memory dir and a self-contained .gitignore that ignores the
// entire .ai-whisper/ subtree — without touching the user's root .gitignore or
// any tracked file. Idempotent.
export function ensureRalphWorkspace(workspaceRoot: string, workflowId: string): string {
	const dir = ralphRunDir(workspaceRoot, workflowId);
	mkdirSync(dir, { recursive: true });
	// Namespace-level ignore — write only if absent (never clobber a user file).
	const ignorePath = join(workspaceRoot, ".ai-whisper", ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "*\n");
	}
	// Guarantee run-state is ignored even when a pre-existing
	// .ai-whisper/.gitignore has content that doesn't cover ralph/: a self-owned
	// .gitignore inside the ralph/ dir (which ai-whisper creates) ignores
	// everything under it regardless of the parent — without editing the user's file.
	const ralphIgnorePath = join(workspaceRoot, ".ai-whisper", "ralph", ".gitignore");
	if (!existsSync(ralphIgnorePath)) {
		writeFileSync(ralphIgnorePath, "*\n");
	}
	return dir;
}
