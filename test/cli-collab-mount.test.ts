import { describe, expect, it, vi } from "vitest";
import { attachClaimSchema, sessionBindingSchema } from "../packages/shared/src/index.ts";
import { readCliCollabState, writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabMount } from "../packages/cli/src/commands/collab/mount.ts";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";

const assessBroker = vi.fn(() =>
	Promise.resolve({ pidAlive: true as const, httpReachable: true as const, ok: true as const }),
);

describe("mount gate — relay monitor check", () => {
	it("rejects mount when no relay monitor connects within the timeout", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-mount-gate-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-06T10:00:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker,
		});

		await expect(
			runCollabMount({
				workspaceRoot,
				target: "codex",
				now: "2026-04-06T10:01:00.000Z",
				resolveCurrentTty: () => "/dev/ttys031",
				assessBroker,
				sleep: () => Promise.resolve(),
				monitorWaitTimeoutMs: 50,
				monitorPollIntervalMs: 10,
			}),
		).rejects.toThrow("Relay monitor not connected");
	});

	it("proceeds past relay monitor check when monitor is registered", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-mount-connected-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-06T10:00:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker,
		});

		// Register a fresh relay monitor so isRelayMonitorConnected returns true
		const state = readCliCollabState(getStateFilePath(workspaceRoot))!;
		const broker = createBrokerRuntime({
			sqlitePath: state.broker.sqlitePath,
			host: state.broker.host,
			port: state.broker.port,
		});
		broker.control.registerRelayMonitor({
			collabId: state.collabId,
			monitorId: "monitor_test_1",
			now: new Date().toISOString(),
		});
		await broker.stop();

		// Provide a fake runtime so the session doesn't actually start
		const fakeRuntime = {
			start: () => Promise.resolve(),
		};

		// Should not throw "Relay monitor not connected"
		await expect(
			runCollabMount({
				workspaceRoot,
				target: "codex",
				now: "2026-04-06T10:01:00.000Z",
				resolveCurrentTty: () => "/dev/ttys031",
				assessBroker,
				createRuntime: () => fakeRuntime as never,
			}),
		).resolves.toBeUndefined();
	});

	it("retries and succeeds when monitor registers after the first poll", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-mount-retry-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-06T10:00:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker,
		});

		const state = readCliCollabState(getStateFilePath(workspaceRoot))!;
		let pollCount = 0;

		// Register the monitor only after the second poll attempt, simulating
		// a slow relay-monitor pane startup in default tmux launch.
		const fakeSleep = async () => {
			pollCount += 1;
			if (pollCount === 2) {
				const broker = createBrokerRuntime({
					sqlitePath: state.broker.sqlitePath,
					host: state.broker.host,
					port: state.broker.port,
				});
				broker.control.registerRelayMonitor({
					collabId: state.collabId,
					monitorId: "monitor_retry_1",
					now: new Date().toISOString(),
				});
				await broker.stop();
			}
		};

		const fakeRuntime = { start: () => Promise.resolve() };

		await expect(
			runCollabMount({
				workspaceRoot,
				target: "codex",
				now: "2026-04-06T10:01:00.000Z",
				resolveCurrentTty: () => "/dev/ttys031",
				assessBroker,
				createRuntime: () => fakeRuntime as never,
				sleep: fakeSleep,
				monitorWaitTimeoutMs: 1000,
				monitorPollIntervalMs: 10,
			}),
		).resolves.toBeUndefined();

		expect(pollCount).toBeGreaterThanOrEqual(2);
	});
});

describe("mounted shared state", () => {
	it("accepts mounted binding sources and mount_current_tty claims", () => {
		const binding = sessionBindingSchema.parse({
			version: 1,
			collabId: "collab_mount",
			agentType: "codex",
			bindingState: "bound",
			activeSessionId: "session_codex_mount",
			bindingSource: "mounted",
			targetTtyPath: "/dev/ttys031",
			pendingClaimId: null,
			pendingClaimExpiresAt: null,
			updatedAt: "2026-04-06T08:00:00.000Z",
		});

		const claim = attachClaimSchema.parse({
			version: 1,
			claimId: "claim_mount_1",
			collabId: "collab_mount",
			agentType: "codex",
			mode: "attach",
			targetMode: "mount_current_tty",
			targetTtyPath: "/dev/ttys031",
			secret: "secret_mount",
			status: "pending",
			createdAt: "2026-04-06T08:00:00.000Z",
			expiresAt: "2026-04-06T08:05:00.000Z",
			consumedAt: null,
		});

		expect(binding.bindingSource).toBe("mounted");
		expect(claim.targetMode).toBe("mount_current_tty");
	});

	it("round-trips mounted runtime metadata in local state", () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-mounted-state-"));
		const path = join(dir, "current-collab.json");

		writeCliCollabState(path, {
			version: 5,
			collabId: "collab_mount",
			workspaceRoot: dir,
			broker: { sqlitePath: join(dir, "broker.sqlite"), host: "127.0.0.1", port: 4311, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: "2026-04-06T08:00:00.000Z",
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
			adoptedSessions: {},
			mountedSessions: {
				codex: {
					agentType: "codex",
					ttyPath: "/dev/ttys031",
					sessionPid: 99234,
				},
			},
		});

		expect(readCliCollabState(path)?.mountedSessions.codex?.ttyPath).toBe("/dev/ttys031");
	});
});
