import { mkdirSync, symlinkSync, existsSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@ai-whisper/broker";
import { runCollabStart } from "../../packages/cli/src/commands/collab/start.ts";
import {
	getBrokerSqlitePath,
	getStateFilePath,
} from "../../packages/cli/src/runtime/paths.ts";
import { getSharedSqlitePath } from "../../packages/cli/src/runtime/state-root.ts";
import { writeCliCollabState } from "../../packages/cli/src/runtime/state-file.ts";
import { canonicalWorkspaceRoot } from "../../packages/cli/src/runtime/workspace-id.ts";

let nextPid = 99100;

export interface StartCollabForTestOpts {
	workspaceRoot: string;
	now: string;
	launchMode: "tmux" | "terminals" | "none";
	explicitPort?: number;
	tmuxSession?: string;
	/**
	 * Override waitForReady. Defaults to immediate success.
	 */
	waitForReady?: (input: {
		host: string;
		port: number;
		collabId: string;
		timeoutMs: number;
	}) => Promise<boolean>;
	/**
	 * Override isPortFreeOs. Defaults to always free.
	 */
	isPortFreeOs?: (port: number) => Promise<boolean>;
	/**
	 * Override signalProcess. Defaults to no-op.
	 */
	signalProcess?: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	/**
	 * Pre-allocated pid to write into broker_daemon during spawnBroker.
	 * Defaults to an auto-incrementing synthetic pid.
	 */
	brokerPid?: number;
	/**
	 * Skip writing the legacy state file (rare; default writes it so that
	 * downstream commands like runCollabStatus / runCollabTell / runCollabStop
	 * can locate the collab).
	 */
	skipLegacyStateFile?: boolean;
}

export interface StartCollabForTestResult {
	collabId: string;
	port: number;
	host: string;
	pid: number;
}

/**
 * Test helper that mirrors the CLI wrapper around runCollabStart:
 *
 * 1. Points AI_WHISPER_STATE_ROOT at the workspace's runtime dir so the new
 *    shared DB lives inside the temp workspace.
 * 2. Calls runCollabStart with the new-shape options, writing a fake pid into
 *    the broker_daemon row from spawnBroker so the daemon readiness check
 *    succeeds.
 * 3. Symlinks the legacy per-workspace broker.sqlite path at the shared DB so
 *    legacy commands (runCollabTell) that still use getBrokerSqlitePath see
 *    the same data.
 * 4. Writes the legacy CLI collab state file pointing at the shared DB so
 *    runCollabStatus / runCollabStop / runCollabMount work.
 */
export async function startCollabForTest(
	opts: StartCollabForTestOpts,
): Promise<StartCollabForTestResult> {
	const workspaceRoot = opts.workspaceRoot;
	const runtimeDir = join(workspaceRoot, ".ai-whisper", "runtime");
	mkdirSync(runtimeDir, { recursive: true });
	process.env.AI_WHISPER_STATE_ROOT = runtimeDir;

	const pid = opts.brokerPid ?? nextPid++;

	const result = await runCollabStart({
		cwd: workspaceRoot,
		displayName: "test",
		launchMode: opts.launchMode,
		...(opts.tmuxSession ? { tmuxSession: opts.tmuxSession } : {}),
		...(opts.explicitPort !== undefined
			? { explicitPort: opts.explicitPort }
			: {}),
		now: () => opts.now,
		isPortFreeOs: opts.isPortFreeOs ?? (async () => true),
		spawnBroker: ({ collabId }) => {
			const db = openDatabase(getSharedSqlitePath());
			db.prepare(
				"UPDATE broker_daemon SET pid = ?, last_heartbeat_at = ? WHERE collab_id = ?",
			).run(pid, opts.now, collabId);
			db.close();
			return pid;
		},
		waitForReady: opts.waitForReady ?? (async () => true),
		signalProcess: opts.signalProcess ?? (() => {}),
	});

	const sharedSqlitePath = getSharedSqlitePath();
	const legacySqlitePath = getBrokerSqlitePath(workspaceRoot);
	if (legacySqlitePath !== sharedSqlitePath && !existsSync(legacySqlitePath)) {
		try {
			symlinkSync(sharedSqlitePath, legacySqlitePath);
		} catch {
			// Symlink may already exist from a previous setup.
		}
	}

	if (!opts.skipLegacyStateFile) {
		const tmuxSession =
			opts.launchMode === "tmux"
				? (opts.tmuxSession ?? `whisper-${result.collabId}`)
				: undefined;
		writeCliCollabState(getStateFilePath(workspaceRoot), {
			version: 5,
			collabId: result.collabId,
			workspaceRoot: canonicalWorkspaceRoot(workspaceRoot),
			broker: {
				sqlitePath: sharedSqlitePath,
				host: result.host as "127.0.0.1",
				port: result.port,
				pid: result.pid,
			},
			launch: {
				mode: opts.launchMode,
				...(tmuxSession ? { tmuxSession } : {}),
			},
			ownedSessions: {},
			startedAt: opts.now,
			recovery: {
				state: "normal",
				idleAfterRecovery: false,
				recoveredAt: null,
			},
			adoptedSessions: {},
			mountedSessions: {},
		});
	}

	return result;
}
