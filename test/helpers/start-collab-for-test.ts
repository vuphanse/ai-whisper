import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "@ai-whisper/broker";
import { runCollabStart } from "../../packages/cli/src/commands/collab/start.ts";
import { getSharedSqlitePath } from "../../packages/cli/src/runtime/state-root.ts";

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
 * 1. Points AI_WHISPER_STATE_ROOT at the workspace's runtime dir so the shared
 *    DB lives inside the temp workspace.
 * 2. Calls runCollabStart with the new-shape options, writing a fake pid into
 *    the broker_daemon row from spawnBroker so the daemon readiness check
 *    succeeds.
 */
export async function startCollabForTest(
	opts: StartCollabForTestOpts,
): Promise<StartCollabForTestResult> {
	const workspaceRoot = opts.workspaceRoot;
	const runtimeDir = join(workspaceRoot, ".ai-whisper", "runtime");
	mkdirSync(runtimeDir, { recursive: true });
	process.env.AI_WHISPER_STATE_ROOT = runtimeDir;

	const pid = opts.brokerPid ?? nextPid++;

	return runCollabStart({
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
}
