import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";

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
});
