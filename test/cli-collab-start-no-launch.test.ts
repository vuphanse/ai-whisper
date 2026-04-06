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
		await runCollabStart({ workspaceRoot, now: "2026-04-05T13:00:00.000Z", launchMode: "none", spawnBroker: fakeBrokerSpawn() });
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
			});
			const allOutput = logSpy.mock.calls.flat().join("\n");
			expect(allOutput).toContain("relay-monitor");
		} finally {
			logSpy.mockRestore();
		}
	});
});
