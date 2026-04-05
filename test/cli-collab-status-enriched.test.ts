import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMockProvider } from "../packages/companion-core/src/index.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";
import { writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

const healthyBroker = vi.fn(() => Promise.resolve({ pidAlive: true as const, httpReachable: true as const, ok: true as const }));

describe("cli collab status enriched", () => {
	it("includes activeThread when a thread exists", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-enriched-"),
		);
		const planPath = join(workspaceRoot, "plan.md");
		writeFileSync(planPath, "# Plan\n");

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		await runCollabTell({
			workspaceRoot,
			target: "codex",
			instruction: "review this plan",
			explicitAction: "review_plan",
			artifactPaths: [planPath],
			threadTitle: "Review plan",
			providerOverride: createMockProvider(),
			now: "2026-04-03T00:00:01.000Z",
			assessBroker: healthyBroker,
		});

		const status = await runCollabStatus({ workspaceRoot, assessBroker: healthyBroker });
		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.activeThread).toMatchObject({
				title: "Review plan",
			});
			expect(status.brokerHealth).toEqual({ ok: true });
			expect(status).not.toHaveProperty("codexSessionId");
			expect(status).not.toHaveProperty("claudeSessionId");
			expect(status.roles.codex.bindingState).toBe("bound");
			expect(status.roles.claude.bindingState).toBe("bound");
		}
	});

	it("returns null activeThread and broker health when no thread exists", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-no-thread-"),
		);

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		const status = await runCollabStatus({ workspaceRoot, assessBroker: healthyBroker });
		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.activeThread).toBeNull();
			expect(status.brokerHealth).toEqual({ ok: true });
			expect(status).not.toHaveProperty("codexSessionId");
			expect(status).not.toHaveProperty("claudeSessionId");
			expect(status.roles.codex.bindingState).toBe("bound");
			expect(status.roles.claude.bindingState).toBe("bound");
		}
	});

	it("shows recovered and degraded state in status output when collab was recovered", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-recovered-"),
		);
		const runtimeDir = join(workspaceRoot, ".ai-whisper", "runtime");
		mkdirSync(runtimeDir, { recursive: true });
		const sqlitePath = join(runtimeDir, "broker.sqlite");
		const collabId = "collab_recovered_status";
		const now = "2026-04-05T19:00:00.000Z";

		// Set up minimal SQLite state
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4430 });
		broker.control.startCollab({
			collabId,
			workspaceRoot,
			displayName: "recovered status test",
			now,
		});
		await broker.stop();

		// Write state file with recovery.state === "recovered"
		const statePath = getStateFilePath(workspaceRoot);
		writeCliCollabState(statePath, {
			version: 3,
			collabId,
			workspaceRoot,
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
				state: "recovered",
				idleAfterRecovery: true,
				recoveredAt: now,
			},
		});

		const status = await runCollabStatus({ workspaceRoot, assessBroker: healthyBroker });
		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.brokerHealth).toEqual({ ok: true });
			expect(status.recovery?.state).toBe("recovered");
			expect(status.idleAfterRecovery).toBe(true);
		}
	});
});
