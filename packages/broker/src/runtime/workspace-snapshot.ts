import { execFileSync } from "node:child_process";

/**
 * Capture the exact working tree as a dangling commit WITHOUT mutating the tree
 * or index (`git stash create`), SYNCHRONOUSLY. Returns the snapshot ref (a
 * commit SHA), or `null` when the dir is not a git repo or stash-create is
 * unavailable. When the tree is fully clean `git stash create` prints nothing;
 * we fall back to HEAD so a later diff against the ref is still well-defined.
 *
 * Synchronous by design: callers (pauseWorkflow, handoffBackRelay) persist the
 * returned ref within the same control method, so an operator who pauses an
 * already-quiesced workflow and immediately resumes cannot race ahead of
 * baseline capture (spec §4 — "immediately if no accepted handoff is in flight").
 */
export function captureWorkspaceSnapshotSync(workspaceRoot: string): string | null {
	try {
		const ref = execFileSync("git", ["-C", workspaceRoot, "stash", "create"], {
			encoding: "utf8",
			timeout: 10_000,
		}).trim();
		if (ref) return ref;
		const head = execFileSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], {
			encoding: "utf8",
			timeout: 10_000,
		}).trim();
		return head || null;
	} catch {
		return null;
	}
}

/**
 * Files that changed between `sinceRef` and the current working tree, scoped to
 * tracked, non-ignored files and excluding `.ai-whisper/` run directories.
 * Returns a sorted, de-duplicated list of repo-relative paths. Returns [] on any
 * git error (degrade, never throw into the resume path).
 *
 * Synchronous so the resume path (`resumeWorkflow`) stays synchronous and does
 * not race the status/notice write.
 */
export function diffChangedFilesSince(workspaceRoot: string, sinceRef: string): string[] {
	try {
		const stdout = execFileSync(
			"git",
			["-C", workspaceRoot, "diff", "--name-only", sinceRef],
			{ encoding: "utf8", timeout: 10_000 },
		);
		const files = stdout
			.split("\n")
			.map((l) => l.trim())
			.filter((l) => l.length > 0 && !l.startsWith(".ai-whisper/"));
		return [...new Set(files)].sort();
	} catch {
		return [];
	}
}
