import {
	applyMigrations,
	deleteBrokerDaemonByCollab,
	getBrokerDaemonByCollab,
	openDatabase,
} from "@ai-whisper/broker";
import { resolveCollab } from "../../runtime/collab-resolver.js";
import { getStateFilePath } from "../../runtime/paths.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";
import { clearCliCollabState } from "../../runtime/state-file.js";

export interface CollabStopOpts {
	cwd: string;
	collabIdOverride?: string;
	now: () => string;
	signalProcess: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
}

export async function runCollabStop(input: CollabStopOpts): Promise<void> {
	const db = openDatabase(getSharedSqlitePath());
	applyMigrations(db);
	let signalTarget: number | null = null;
	let resolvedWorkspaceRoot: string | null = null;
	try {
		const resolved = resolveCollab({
			db,
			cwd: input.cwd,
			...(input.collabIdOverride
				? { collabIdOverride: input.collabIdOverride }
				: {}),
			requireActive: true,
		});
		resolvedWorkspaceRoot = resolved.workspaceRoot;
		const tx = db.transaction(() => {
			const daemonRow = getBrokerDaemonByCollab(db, resolved.collabId);
			if (daemonRow && daemonRow.pid !== null) {
				signalTarget = daemonRow.pid;
			}
			deleteBrokerDaemonByCollab(db, resolved.collabId);
			const now = input.now();
			db.prepare(
				"UPDATE collab SET status='stopped', stopped_at=?, updated_at=? WHERE collab_id = ?",
			).run(now, now, resolved.collabId);
		});
		tx.immediate();
	} finally {
		db.close();
	}

	if (signalTarget !== null) {
		try {
			input.signalProcess(signalTarget, "SIGTERM");
		} catch {
			// process may already be dead
		}
	}

	// LEGACY BRIDGE (removed in Task 24): clear state.json so mount panes and
	// other unmigrated consumers see no active collab.
	if (resolvedWorkspaceRoot !== null) {
		try {
			clearCliCollabState(getStateFilePath(resolvedWorkspaceRoot));
		} catch {
			// state file may already be absent
		}
	}
}
