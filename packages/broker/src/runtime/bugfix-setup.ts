import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { bugfixRunDir } from "./workflow-registry.js";

// Creates the run's artifact dir and self-contained .gitignore files that ignore
// the .ai-whisper/ subtree — without touching the user's root .gitignore or any
// tracked file. Mirrors ensureRalphWorkspace exactly. Idempotent.
//
// Why this is required (not optional): the bugfix kickoff/fix templates and the
// docs both promise the run dir "is gitignored". In a user workspace that has
// never run ralph, nothing ignores .ai-whisper/, so without these writes the
// diagnosis/postmortem artifacts would be committable — breaking that contract.
export function ensureBugfixWorkspace(
	workspaceRoot: string,
	workflowId: string,
): string {
	const dir = bugfixRunDir(workspaceRoot, workflowId);
	mkdirSync(dir, { recursive: true });
	// Namespace-level ignore — write only if absent (never clobber a user file).
	const ignorePath = join(workspaceRoot, ".ai-whisper", ".gitignore");
	if (!existsSync(ignorePath)) {
		writeFileSync(ignorePath, "*\n");
	}
	// Guarantee run-state is ignored even when a pre-existing
	// .ai-whisper/.gitignore has content that doesn't cover bugfix/: a self-owned
	// .gitignore inside the bugfix/ dir ignores everything under it regardless of
	// the parent — without editing the user's file.
	const bugfixIgnorePath = join(workspaceRoot, ".ai-whisper", "bugfix", ".gitignore");
	if (!existsSync(bugfixIgnorePath)) {
		writeFileSync(bugfixIgnorePath, "*\n");
	}
	return dir;
}
