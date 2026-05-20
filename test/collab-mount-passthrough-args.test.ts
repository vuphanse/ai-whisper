import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	applyMigrations,
	insertBrokerDaemon,
	openDatabase,
	upsertRecoveryState,
	upsertWorkspace,
} from "@ai-whisper/broker";
import { runCollabMount } from "../packages/cli/src/commands/collab/mount.ts";
import { createMountSessionRuntime } from "../packages/cli/src/runtime/mount-session-main.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import {
	canonicalWorkspaceRoot,
	workspaceIdFromPath,
} from "../packages/cli/src/runtime/workspace-id.ts";

function tempStateRoot(): string {
	return mkdtempSync(join(tmpdir(), "aiw-mount-pass-"));
}

/**
 * Seed an active collab + broker_daemon row directly in the shared DB so
 * runCollabMount's tryResolve() succeeds without spawning a real broker
 * daemon process. Avoids parallel-test port contention. Mirrors the rows
 * runCollabStart would insert.
 */
function seedActiveCollab(workspaceRoot: string): string {
	const now = new Date().toISOString();
	const workspaceId = workspaceIdFromPath(workspaceRoot);
	const canonical = canonicalWorkspaceRoot(workspaceRoot);
	const collabId = `collab_${now.replace(/[^0-9]/g, "")}_seed`;
	const db = openDatabase(getSharedSqlitePath());
	try {
		applyMigrations(db);
		upsertWorkspace(db, { id: workspaceId, workspaceRoot: canonical, now });
		db.prepare(
			"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, tmux_session, created_at, updated_at, orchestrator_enabled, orchestrator_max_rounds) VALUES (?, ?, ?, 'active', ?, 'none', NULL, ?, ?, 1, 3)",
		).run(collabId, canonical, "ws-seed", workspaceId, now, now);
		insertBrokerDaemon(db, {
			collabId,
			host: "127.0.0.1",
			// brokerConfigSchema requires a positive int port; the seeded
			// daemon is never actually listened on (assessBroker is mocked),
			// so any positive number works.
			port: 4734,
			startedAt: now,
			lastHeartbeatAt: now,
		});
		// Set a live pid so the resolver / heartbeat checks don't mark it stale.
		db.prepare(
			"UPDATE broker_daemon SET pid = ? WHERE collab_id = ?",
		).run(process.pid, collabId);
		upsertRecoveryState(db, {
			collabId,
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
	} finally {
		db.close();
	}
	return collabId;
}

describe("runCollabMount passthrough args", () => {
	let prevStateRoot: string | undefined;

	beforeEach(() => {
		prevStateRoot = process.env.AI_WHISPER_STATE_ROOT;
	});

	afterEach(() => {
		if (prevStateRoot === undefined) {
			delete process.env.AI_WHISPER_STATE_ROOT;
		} else {
			process.env.AI_WHISPER_STATE_ROOT = prevStateRoot;
		}
	});

	it("forwards user-supplied passthrough args to createMountSessionRuntime", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws");
		mkdirSync(workspaceRoot, { recursive: true });
		seedActiveCollab(workspaceRoot);

		const capturedInputs: Array<{ passthroughArgs?: string[] }> = [];
		const fakeRuntime = { start: vi.fn(async () => undefined) };
		const createRuntime = vi.fn((cfg: { passthroughArgs?: string[] }) => {
			capturedInputs.push(cfg);
			return fakeRuntime as never;
		});

		await runCollabMount({
			workspaceRoot,
			target: "codex",
			passthroughArgs: ["--full-auto", "--model", "gpt-5"],
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime,
			assessBroker: async () =>
				({
					pidAlive: true,
					httpReachable: true,
					ok: true,
				}) as never,
		});

		expect(capturedInputs.length).toBe(1);
		expect(capturedInputs[0]?.passthroughArgs).toEqual([
			"--full-auto",
			"--model",
			"gpt-5",
		]);
	});

	it("forwards [] when no passthroughArgs are provided", async () => {
		const stateRoot = tempStateRoot();
		process.env.AI_WHISPER_STATE_ROOT = stateRoot;
		const workspaceRoot = join(stateRoot, "ws-empty");
		mkdirSync(workspaceRoot, { recursive: true });
		seedActiveCollab(workspaceRoot);

		const capturedInputs: Array<{ passthroughArgs?: string[] }> = [];
		const fakeRuntime = { start: vi.fn(async () => undefined) };
		const createRuntime = vi.fn((cfg: { passthroughArgs?: string[] }) => {
			capturedInputs.push(cfg);
			return fakeRuntime as never;
		});

		await runCollabMount({
			workspaceRoot,
			target: "codex",
			now: new Date().toISOString(),
			resolveCurrentTty: () => "/dev/null",
			createRuntime,
			assessBroker: async () =>
				({
					pidAlive: true,
					httpReachable: true,
					ok: true,
				}) as never,
		});

		expect(capturedInputs.length).toBe(1);
		expect(capturedInputs[0]?.passthroughArgs).toEqual([]);
	});

	it("createMountSessionRuntime threads passthroughArgs into the interactive session config, not the provider", async () => {
		const capturedInteractive: Array<{ passthroughArgs?: string[] }> = [];
		const capturedProvider: Array<unknown> = [];

		const runtime = createMountSessionRuntime({
			target: "codex",
			ttyPath: "/dev/ttys999",
			workspaceRoot: "/tmp/workspace-passthrough",
			claimId: "claim_pass_1",
			secret: "secret_pass",
			passthroughArgs: ["--full-auto", "--model", "gpt-5"],
			broker: {
				control: {
					completeAttachClaim: () => ({
						collabId: "collab_pass",
						sessionId: "session_codex_pass",
						agentType: "codex",
					}),
					listSessionBindings: () => [],
					listSessions: () => [],
					markSessionDegraded: vi.fn(),
					getRelayTurnState: () => ({
						collabId: "collab_pass",
						turnOwner: "none",
						waitingAgent: null,
						unresolvedHandoffId: null,
						handoffState: "idle",
						handoffAgeMs: null,
					}),
					getRelayHandoff: () => null,
				},
				stop: () => Promise.resolve(),
			} as never,
			createInteractiveSession: (cfg) => {
				capturedInteractive.push(cfg);
				return {
					start: () => Promise.resolve(),
					stop: () => Promise.resolve(),
					writeUserInput() {},
					sendLocalMessage() {},
					onExit() {},
				} as never;
			},
			createLiveSession: () =>
				({
					start: () => Promise.resolve(),
					stop: () => Promise.resolve(),
				}) as never,
			createProvider: (target) => {
				capturedProvider.push(target);
				return {
					getIdentity: () => ({
						providerId: "codex-cli",
						toolFamily: "codex",
						providerVersion: "1.0.0",
					}),
					getCapabilities: () => ({
						supportsDirectPackets: true,
						supportsNormalization: false,
						supportsRelayInterception: true,
						supportsLocalBuffering: true,
						supportsLaunchHooks: false,
						extensions: {},
					}),
					getHealthState: () => "healthy" as const,
					handleWork: () =>
						Promise.resolve({
							kind: "answer" as const,
							content: "ok",
							transitionIntent: null,
						}),
				} as never;
			},
			runLoop: () => Promise.resolve(async () => {}),
		});

		await runtime.start();

		expect(capturedInteractive.length).toBe(1);
		expect(capturedInteractive[0]?.passthroughArgs).toEqual([
			"--full-auto",
			"--model",
			"gpt-5",
		]);
		// createProviderForTarget is invoked with the bare target string —
		// it never sees passthrough args. Belt-and-suspenders against
		// accidentally threading flags into the wrong code path.
		expect(capturedProvider).toEqual(["codex"]);
	});
});
