import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fakeBrokerSpawn, healthyBrokerAssess } from "./helpers/fake-broker-spawn.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { createBrokerRuntime } from "@ai-whisper/broker";
import { getBrokerSqlitePath } from "../packages/cli/src/runtime/paths.ts";

describe("cli collab start --no-launch", () => {
	it("creates an active collab with both roles unbound", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-no-launch-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-05T13:00:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker: vi.fn().mockResolvedValue({ pidAlive: true, httpReachable: true, ok: true }) as never,
		});
		const status = await runCollabStatus({ workspaceRoot });
		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.roles.codex).toMatchObject({ bindingState: "unbound" });
			expect(status.roles.claude).toMatchObject({ bindingState: "unbound" });
		}
	});

	it("prints relay-monitor instruction in no-launch mode", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-no-launch-msg-"));
		const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
		try {
			await runCollabStart({
				workspaceRoot,
				now: "2026-04-05T13:00:00.000Z",
				launchMode: "none",
				spawnBroker: fakeBrokerSpawn(),
				assessBroker: vi.fn().mockResolvedValue({ pidAlive: true, httpReachable: true, ok: true }) as never,
			});
			const allOutput = logSpy.mock.calls.flat().join("\n");
			expect(allOutput).toContain("relay-monitor");
		} finally {
			logSpy.mockRestore();
		}
	});

	it("waits for the broker daemon to become healthy before finishing no-launch startup", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-no-launch-ready-"));
		const assessBroker = vi
			.fn()
			.mockResolvedValueOnce({ pidAlive: true, httpReachable: false, ok: false })
			.mockResolvedValueOnce({ pidAlive: true, httpReachable: false, ok: false })
			.mockResolvedValueOnce({ pidAlive: true, httpReachable: true, ok: true });
		const sleep = vi.fn(() => Promise.resolve());

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-05T13:00:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker: assessBroker as never,
			sleep,
		});

		expect(assessBroker).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenCalledTimes(2);
	});

	it("persists orchestrator config from environment when collab starts", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-no-launch-orch-"));
		process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED = "1";
		process.env.AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS = "5";

		try {
			const result = await runCollabStart({
				workspaceRoot,
				now: "2026-04-11T00:00:00.000Z",
				launchMode: "none",
				spawnBroker: fakeBrokerSpawn(),
				assessBroker: healthyBrokerAssess,
			});

			const sqlitePath = getBrokerSqlitePath(workspaceRoot);
			const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4311 });
			expect(broker.control.getCollab(result.collabId)).toEqual(
				expect.objectContaining({
					orchestratorEnabled: true,
					orchestratorMaxRounds: 5,
				}),
			);
		} finally {
			delete process.env.AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED;
			delete process.env.AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS;
		}
	});
});
