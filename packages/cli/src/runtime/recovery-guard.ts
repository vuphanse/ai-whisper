import {
	openDatabase,
	getBrokerDaemonByCollab,
	defaultIsAlive,
	type IsAliveResult,
} from "@ai-whisper/broker";
import { resolveCollab, CollabResolverError } from "./collab-resolver.js";
import { getSharedSqlitePath } from "./state-root.js";

export interface RecoveryEvaluation {
	healthy: boolean;
	reason?: string;
	collabId?: string;
}

export async function evaluateRecoveryNeed(input: {
	cwd: string;
	collabIdOverride?: string;
	isAlive?: (pid: number) => Promise<IsAliveResult>;
}): Promise<RecoveryEvaluation> {
	const db = openDatabase(getSharedSqlitePath());
	try {
		let resolved;
		try {
			resolved = resolveCollab({
				db,
				cwd: input.cwd,
				...(input.collabIdOverride !== undefined
					? { collabIdOverride: input.collabIdOverride }
					: {}),
			});
		} catch (err) {
			if (
				err instanceof CollabResolverError &&
				err.kind === "NoCollabFoundForCwd"
			) {
				return { healthy: true };
			}
			throw err;
		}
		const daemonRow = getBrokerDaemonByCollab(db, resolved.collabId);
		if (!daemonRow) {
			return {
				healthy: false,
				reason: "no broker_daemon row",
				collabId: resolved.collabId,
			};
		}
		if (daemonRow.pid === null) {
			return {
				healthy: false,
				reason: "daemon never wrote pid (orphan reservation)",
				collabId: resolved.collabId,
			};
		}
		const check = await (input.isAlive ?? defaultIsAlive)(daemonRow.pid);
		if (!check.alive) {
			return {
				healthy: false,
				reason: `pid ${daemonRow.pid} not alive`,
				collabId: resolved.collabId,
			};
		}
		if (
			daemonRow.pidStartTime !== null &&
			check.startTime !== null &&
			daemonRow.pidStartTime !== check.startTime
		) {
			return {
				healthy: false,
				reason: "pid was reused by another process",
				collabId: resolved.collabId,
			};
		}
		return { healthy: true, collabId: resolved.collabId };
	} finally {
		db.close();
	}
}
