import { describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCliCollabState, writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { assessBrokerDaemon } from "../packages/cli/src/runtime/broker-daemon.ts";
import { runCollabRecover } from "../packages/cli/src/commands/collab/recover.ts";
import { runCollabReconnect } from "../packages/cli/src/commands/collab/reconnect.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import { createBrokerRuntime, upsertRecoveryState, upsertWorkspace } from "../packages/broker/src/index.ts";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";

describe("cli recovery state", () => {
	it("normalizes v2 state into v3 recovery defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-recovery-state-"));
		const statePath = join(dir, "current-collab.json");
		writeFileSync(statePath, JSON.stringify({
			version: 2,
			collabId: "collab_v2",
			workspaceRoot: "/tmp/workspace",
			broker: {
				sqlitePath: "/tmp/workspace/.ai-whisper/runtime/broker.sqlite",
				host: "127.0.0.1",
				port: 4311,
				pid: 99123,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: "2026-04-05T15:55:00.000Z",
		}));

		expect(readCliCollabState(statePath)?.recovery).toEqual({
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
	});

	it("marks the broker unavailable when pid and health probe both fail", async () => {
		const result = await assessBrokerDaemon({
			host: "127.0.0.1",
			port: 4311,
			pid: 99999,
			fetchImpl: vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED"))) as never,
			killImpl: vi.fn(() => {
				throw new Error("no such process");
			}) as never,
		});

		expect(result).toEqual({
			pidAlive: false,
			httpReachable: false,
			ok: false,
		});
	});
});

describe("recover command", () => {
	async function buildRecoveryFixture() {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-recover-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const collabId = "collab_recover_test";
		const now = "2026-04-05T16:00:00.000Z";

		// Set up broker state in the real SQLite file
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4399 });
		broker.control.startCollab({
			collabId,
			workspaceRoot: dir,
			displayName: "recover test",
			now,
		});
		broker.control.registerSession({
			sessionId: "session_codex_1",
			collabId,
			agentType: "codex",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now,
		});
		broker.control.setSessionBinding({
			collabId,
			agentType: "codex",
			sessionId: "session_codex_1",
			bindingSource: "attached",
			now,
		});
		await broker.stop();

		// Write state file
		const runtimeDir = join(dir, ".ai-whisper", "runtime");
		const statePath = join(runtimeDir, "current-collab.json");
		writeCliCollabState(statePath, {
			version: 5,
			collabId,
			workspaceRoot: dir,
			broker: {
				sqlitePath,
				host: "127.0.0.1",
				port: 4399,
				pid: 99123,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: {
				state: "normal",
				idleAfterRecovery: false,
				recoveredAt: null,
			},
			adoptedSessions: {},
			mountedSessions: {},
		});

		return { dir, statePath, collabId, sqlitePath, now };
	}

	it("restores the collab pessimistically when the broker is unavailable", async () => {
		const { dir, now } = await buildRecoveryFixture();

		const mockAssessBroker = vi.fn(() => Promise.resolve({
			pidAlive: false as const,
			httpReachable: false as const,
			ok: false as const,
		}));
		const mockSpawnBroker = vi.fn(() => 99123);

		const result = await runCollabRecover({
			workspaceRoot: dir,
			now,
			assessBroker: mockAssessBroker,
			spawnBroker: mockSpawnBroker,
		});

		expect(result.recovered).toBe(true);
		expect(result.idleAfterRecovery).toBe(true);
		expect(result.roles.codex.health).toBe("degraded");
		expect(result.roles.claude.health).toBe("degraded");

		// Verify the state file was updated
		const updatedState = readCliCollabState(getStateFilePath(dir));
		expect(updatedState?.recovery.state).toBe("recovered");
		expect(updatedState?.recovery.idleAfterRecovery).toBe(true);
		expect(updatedState?.recovery.recoveredAt).toBe(now);
		expect(updatedState?.broker.pid).toBe(99123);
	});

	it("throws when broker is already healthy", async () => {
		const { dir, now } = await buildRecoveryFixture();

		const mockAssessBroker = vi.fn(() => Promise.resolve({
			pidAlive: true as const,
			httpReachable: true as const,
			ok: true as const,
		}));
		const mockSpawnBroker = vi.fn(() => 99456);

		await expect(
			runCollabRecover({
				workspaceRoot: dir,
				now,
				assessBroker: mockAssessBroker,
				spawnBroker: mockSpawnBroker,
			}),
		).rejects.toThrow(/already healthy/i);
	});

	it("throws when no active collab state is found", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-recover-empty-"));
		const mockAssessBroker = vi.fn(() => Promise.resolve({ pidAlive: false as const, httpReachable: false as const, ok: false as const }));
		const mockSpawnBroker = vi.fn(() => 99789);

		await expect(
			runCollabRecover({
				workspaceRoot: dir,
				now: "2026-04-05T16:00:00.000Z",
				assessBroker: mockAssessBroker,
				spawnBroker: mockSpawnBroker,
			}),
		).rejects.toThrow(/no active collab/i);
	});

	it("writes normal recovery state when no remembered bindings exist after recovery", async () => {
		// Set up a workspace with a fresh broker that has no bindings (no sessions ever attached)
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-recover-nobindings-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const collabId = "collab_recover_nobindings";
		const now = "2026-04-05T16:30:00.000Z";

		// Create a broker with a collab but no registered sessions and no bindings
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4401 });
		broker.control.startCollab({
			collabId,
			workspaceRoot: dir,
			displayName: "no bindings test",
			now,
		});
		// Intentionally do NOT register any sessions or set any bindings
		await broker.stop();

		// Write state file
		const runtimeDir = join(dir, ".ai-whisper", "runtime");
		const statePath = join(runtimeDir, "current-collab.json");
		writeCliCollabState(statePath, {
			version: 5,
			collabId,
			workspaceRoot: dir,
			broker: {
				sqlitePath,
				host: "127.0.0.1",
				port: 4401,
				pid: 99123,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: {
				state: "normal",
				idleAfterRecovery: false,
				recoveredAt: null,
			},
			adoptedSessions: {},
			mountedSessions: {},
		});

		const mockAssessBroker = vi.fn(() => Promise.resolve({
			pidAlive: false as const,
			httpReachable: false as const,
			ok: false as const,
		}));
		const mockSpawnBroker = vi.fn(() => 99999);

		const result = await runCollabRecover({
			workspaceRoot: dir,
			now,
			assessBroker: mockAssessBroker,
			spawnBroker: mockSpawnBroker,
		});

		// When no bindings exist, recovery is complete with no remembered sessions
		expect(result.recovered).toBe(true);
		expect(result.idleAfterRecovery).toBe(false);
		expect(result.bindings).toHaveLength(0);

		// The state file must have recovery.state === "normal" — not "recovered"
		// so that runCollabAttach is NOT blocked by the recovery guard
		const updatedState = readCliCollabState(getStateFilePath(dir));
		expect(updatedState?.recovery.state).toBe("normal");
		expect(updatedState?.recovery.idleAfterRecovery).toBe(false);
		expect(updatedState?.recovery.recoveredAt).toBeNull();
	});
});

describe("reconnect command", () => {
	async function buildReconnectFixture() {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-reconnect-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const collabId = "collab_reconnect_test";
		const now = "2026-04-05T17:00:00.000Z";

		// Set up broker state: codex session registered but marked degraded (post-recovery)
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4410 });
		broker.control.startCollab({
			collabId,
			workspaceRoot: dir,
			displayName: "reconnect test",
			now,
		});
		broker.control.registerSession({
			sessionId: "session_codex_degraded",
			collabId,
			agentType: "codex",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now,
		});
		broker.control.setSessionBinding({
			collabId,
			agentType: "codex",
			sessionId: "session_codex_degraded",
			bindingSource: "attached",
			now,
		});
		// Mark session degraded (simulating post-recovery state)
		broker.control.prepareCollabRecovery({ collabId, now });
		await broker.stop();

		// Write state file with recovery.state === "recovered"
		const runtimeDir = join(dir, ".ai-whisper", "runtime");
		const statePath = join(runtimeDir, "current-collab.json");
		writeCliCollabState(statePath, {
			version: 5,
			collabId,
			workspaceRoot: dir,
			broker: {
				sqlitePath,
				host: "127.0.0.1",
				port: 4410,
				pid: 99123,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: {
				state: "recovered",
				idleAfterRecovery: true,
				recoveredAt: now,
			},
			adoptedSessions: {},
			mountedSessions: {},
		});

		return { dir, statePath, collabId, sqlitePath, now };
	}

	it("throws when recovery.state is not 'recovered'", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-reconnect-notrecov-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const collabId = "collab_reconnect_notrecov";
		const now = "2026-04-05T17:00:00.000Z";

		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4411 });
		broker.control.startCollab({ collabId, workspaceRoot: dir, displayName: "test", now });
		await broker.stop();

		const runtimeDir = join(dir, ".ai-whisper", "runtime");
		const statePath = join(runtimeDir, "current-collab.json");
		writeCliCollabState(statePath, {
			version: 5,
			collabId,
			workspaceRoot: dir,
			broker: { sqlitePath, host: "127.0.0.1", port: 4411, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
			adoptedSessions: {},
			mountedSessions: {},
		});

		await expect(
			runCollabReconnect({ workspaceRoot: dir, target: "codex", now }),
		).rejects.toThrow(/recovered/i);
	});

	it("throws when the target has no remembered binding", async () => {
		const { dir, now } = await buildReconnectFixture();

		// claude has no binding, so reconnect for claude should throw
		await expect(
			runCollabReconnect({ workspaceRoot: dir, target: "claude", now }),
		).rejects.toThrow(/no remembered binding/i);
	});

});

describe("recovery guards", () => {
	async function buildGuardFixture(recoveryState: "recovery_required" | "recovered") {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-guard-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const collabId = "collab_guard_test";
		const now = "2026-04-05T18:00:00.000Z";

		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4420 });
		broker.control.startCollab({
			collabId,
			workspaceRoot: dir,
			displayName: "guard test",
			now,
		});
		broker.control.registerSession({
			sessionId: "session_codex_guard",
			collabId,
			agentType: "codex",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now,
		});
		await broker.stop();

		const runtimeDir = join(dir, ".ai-whisper", "runtime");
		const statePath = join(runtimeDir, "current-collab.json");
		writeCliCollabState(statePath, {
			version: 5,
			collabId,
			workspaceRoot: dir,
			broker: {
				sqlitePath,
				host: "127.0.0.1",
				port: 4420,
				pid: 99123,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: {
				state: recoveryState,
				idleAfterRecovery: recoveryState === "recovered",
				recoveredAt: recoveryState === "recovered" ? now : null,
			},
			adoptedSessions: {},
			mountedSessions: {},
		});

		return { dir, now };
	}

	it("tells the operator to run recover when tell is attempted against a collab that needs recovery", async () => {
		const { dir, now } = await buildGuardFixture("recovery_required");

		await expect(
			runCollabTell({
				workspaceRoot: dir,
				target: "codex",
				instruction: "review this",
				artifactPaths: [],
				now,
			}),
		).rejects.toThrow(/whisper collab recover/i);
	});

	it("tells the operator to run reconnect when tell is attempted against a recovered collab", async () => {
		const { dir, now } = await buildGuardFixture("recovered");

		await expect(
			runCollabTell({
				workspaceRoot: dir,
				target: "codex",
				instruction: "review this",
				artifactPaths: [],
				now,
			}),
		).rejects.toThrow(/whisper collab reconnect/i);
	});

});

describe("broker latch", () => {
	async function buildNormalStateFixture() {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-latch-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const collabId = "collab_latch_test";
		const now = "2026-04-05T19:00:00.000Z";

		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4430 });
		broker.control.startCollab({
			collabId,
			workspaceRoot: dir,
			displayName: "latch test",
			now,
		});
		broker.control.registerSession({
			sessionId: "session_codex_latch",
			collabId,
			agentType: "codex",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now,
		});
		broker.control.setSessionBinding({
			collabId,
			agentType: "codex",
			sessionId: "session_codex_latch",
			bindingSource: "attached",
			now,
		});
		await broker.stop();

		const runtimeDir = join(dir, ".ai-whisper", "runtime");
		const statePath = join(runtimeDir, "current-collab.json");
		writeCliCollabState(statePath, {
			version: 5,
			collabId,
			workspaceRoot: dir,
			broker: {
				sqlitePath,
				host: "127.0.0.1",
				port: 4430,
				pid: 99123,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: {
				state: "normal",
				idleAfterRecovery: false,
				recoveredAt: null,
			},
			adoptedSessions: {},
			mountedSessions: {},
		});

		return { dir, statePath, collabId, sqlitePath, now };
	}

	it("latches recovery_required into state file when tell is called with a dead broker", async () => {
		const { dir } = await buildNormalStateFixture();
		const now = "2026-04-05T19:00:00.000Z";

		const mockAssessBroker = vi.fn(() => Promise.resolve({
			pidAlive: false as const,
			httpReachable: false as const,
			ok: false as const,
		}));

		await expect(
			runCollabTell({
				workspaceRoot: dir,
				target: "codex",
				instruction: "review this",
				artifactPaths: [],
				now,
				assessBroker: mockAssessBroker,
			}),
		).rejects.toThrow(/whisper collab recover/i);

		const updatedState = readCliCollabState(getStateFilePath(dir));
		expect(updatedState?.recovery.state).toBe("recovery_required");
	});

});

describe("status command recovery awareness", () => {
	it("shows recovery_required state in status when collab is marked recovery_required", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "ai-whisper-status-recovery-"));
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		try {
			const ws = join(tmp, "ws");
			mkdirSync(ws);
			const collabId = "collab_status_recovery";
			const now = "2026-04-05T16:05:00.000Z";

			const sharedDb = openDatabase(getSharedSqlitePath());
			applyMigrations(sharedDb);
			const wsId = workspaceIdFromPath(ws);
			upsertWorkspace(sharedDb, { id: wsId, workspaceRoot: ws, now });
			sharedDb
				.prepare(
					"INSERT INTO collab (collab_id, workspace_root, display_name, status, workspace_id, launch_mode, created_at, updated_at) VALUES (?, ?, 'status recovery test', 'active', ?, 'none', ?, ?)",
				)
				.run(collabId, ws, wsId, now, now);
			upsertRecoveryState(sharedDb, {
				collabId,
				state: "recovery_required",
				idleAfterRecovery: false,
				recoveredAt: null,
			});
			sharedDb.close();

			const output = await runCollabStatus({ cwd: ws });
			expect(output).toContain(collabId);
			expect(output).toContain("recovery: recovery_required");
			expect(output).toContain("daemon: not running");
		} finally {
			delete process.env.AI_WHISPER_STATE_ROOT;
		}
	});
});

async function buildMountedReconnectFixture() {
	const dir = mkdtempSync(join(tmpdir(), "ai-whisper-reconnect-mounted-"));
	const sqlitePath = join(dir, "broker.sqlite");
	const collabId = "collab_reconnect_mounted";
	const now = "2026-04-06T09:00:00.000Z";

	const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4413 });
	broker.control.startCollab({ collabId, workspaceRoot: dir, displayName: "reconnect mounted", now });
	broker.control.registerSession({
		sessionId: "session_codex_mounted",
		collabId,
		agentType: "codex",
		capabilities: {
			supportsDirectPackets: true,
			supportsNormalization: false,
			supportsRelayInterception: true,
			supportsLocalBuffering: true,
			supportsLaunchHooks: false,
			extensions: {},
		},
		now,
	});
	broker.control.setSessionBinding({
		collabId,
		agentType: "codex",
		sessionId: "session_codex_mounted",
		bindingSource: "mounted",
		now,
	});
	broker.control.prepareCollabRecovery({ collabId, now });
	await broker.stop();

	writeCliCollabState(join(dir, ".ai-whisper", "runtime", "current-collab.json"), {
		version: 5,
		collabId,
		workspaceRoot: dir,
		broker: { sqlitePath, host: "127.0.0.1", port: 4413, pid: 99123 },
		launch: { mode: "none" },
		ownedSessions: {},
		startedAt: now,
		recovery: { state: "recovered", idleAfterRecovery: true, recoveredAt: now },
		adoptedSessions: {},
		mountedSessions: {},
	});

	return { dir, now };
}

describe("mounted reconnect", () => {
	it("defaults to mounted mode when the remembered binding source is mounted", async () => {
		const { dir, now } = await buildMountedReconnectFixture();
		const startMountedSession = vi.fn(() => Promise.resolve());
		const result = await runCollabReconnect({
			workspaceRoot: dir,
			target: "codex",
			now,
			resolveCurrentTty: () => "/dev/ttys031",
			startMountedSession,
		});

		expect(result.mode).toBe("mounted");
		expect(startMountedSession).toHaveBeenCalledWith(expect.objectContaining({ ttyPath: "/dev/ttys031" }));
	});

});
