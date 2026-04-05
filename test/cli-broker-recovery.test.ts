import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCliCollabState, writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { assessBrokerDaemon } from "../packages/cli/src/runtime/broker-daemon.ts";
import { runCollabRecover } from "../packages/cli/src/commands/collab/recover.ts";
import { runCollabReconnect } from "../packages/cli/src/commands/collab/reconnect.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

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
			version: 3,
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
			version: 3,
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
		});

		return { dir, statePath, collabId, sqlitePath, now };
	}

	it("prints a reconnect snippet for a degraded remembered role", async () => {
		const { dir, now } = await buildReconnectFixture();

		const result = runCollabReconnect({
			workspaceRoot: dir,
			target: "codex",
			now,
		});

		expect(result.claim.mode).toBe("reconnect");
		expect(result.snippet).toContain("attach-session");
		expect(result.snippet).toContain("codex");
	});

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
			version: 3,
			collabId,
			workspaceRoot: dir,
			broker: { sqlitePath, host: "127.0.0.1", port: 4411, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
		});

		expect(() =>
			runCollabReconnect({ workspaceRoot: dir, target: "codex", now }),
		).toThrow(/recovered/i);
	});

	it("throws when the target has no remembered binding", async () => {
		const { dir, now } = await buildReconnectFixture();

		// claude has no binding, so reconnect for claude should throw
		expect(() =>
			runCollabReconnect({ workspaceRoot: dir, target: "claude", now }),
		).toThrow(/no remembered binding/i);
	});
});

describe("status command recovery awareness", () => {
	it("shows recovery_required state in status when broker is unavailable", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-status-recovery-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const collabId = "collab_status_recovery";
		const now = "2026-04-05T16:05:00.000Z";

		// Set up a minimal SQLite database for the collab
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4400 });
		broker.control.startCollab({
			collabId,
			workspaceRoot: dir,
			displayName: "status recovery test",
			now,
		});
		await broker.stop();

		// Write state file
		const runtimeDir = join(dir, ".ai-whisper", "runtime");
		const statePath = join(runtimeDir, "current-collab.json");
		writeCliCollabState(statePath, {
			version: 3,
			collabId,
			workspaceRoot: dir,
			broker: {
				sqlitePath,
				host: "127.0.0.1",
				port: 4400,
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
		});

		const mockAssessBroker = vi.fn(() => Promise.resolve({
			pidAlive: false as const,
			httpReachable: false as const,
			ok: false as const,
		}));

		const status = await runCollabStatus({
			workspaceRoot: dir,
			assessBroker: mockAssessBroker,
		});

		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.brokerHealth.ok).toBe(false);
			expect(status.recovery?.state).toBe("recovery_required");
		}
	});
});
