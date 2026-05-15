import {
	openDatabase,
	getBrokerDaemonByCollab,
	defaultIsAlive,
	type IsAliveResult,
} from "@ai-whisper/broker";
import { assessBrokerDaemon } from "./broker-daemon.js";
import { writeCliCollabState } from "./state-file.js";
import { getStateFilePath } from "./paths.js";
import { resolveCollab, CollabResolverError } from "./collab-resolver.js";
import { getSharedSqlitePath } from "./state-root.js";
import type { CliCollabState } from "./state-file.js";

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

export function assertNormalBrokerState(state: CliCollabState): void {
	if (state.recovery.state === "recovery_required") {
		throw new Error(
			"Broker is unavailable for the current collab. Run `whisper collab recover`.",
		);
	}
	if (state.recovery.state === "recovered") {
		throw new Error(
			"Collab has been recovered and still needs reconnect. Run `whisper collab reconnect <codex|claude>`.",
		);
	}
}

export async function probeAndLatchBrokerState(
	state: CliCollabState,
	workspaceRoot: string,
	assessBroker?: typeof assessBrokerDaemon,
): Promise<void> {
	if (state.recovery.state !== "normal") {
		assertNormalBrokerState(state);
		return;
	}

	const health = await (assessBroker ?? assessBrokerDaemon)({
		host: state.broker.host,
		port: state.broker.port,
		pid: state.broker.pid,
	});

	if (!health.ok) {
		writeCliCollabState(getStateFilePath(workspaceRoot), {
			...state,
			recovery: {
				state: "recovery_required",
				idleAfterRecovery: state.recovery.idleAfterRecovery,
				recoveredAt: state.recovery.recoveredAt,
			},
		});
		throw new Error(
			"Broker is unavailable for the current collab. Run `whisper collab recover`.",
		);
	}
}
