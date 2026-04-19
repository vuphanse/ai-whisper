import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import { fakeBrokerSpawn, healthyBrokerAssess } from "./helpers/fake-broker-spawn.ts";

describe("cli collab lifecycle", () => {
	it("starts a collab, reports status, and stops it", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-phase5-cli-"));

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker: healthyBrokerAssess,
			spawn: () => {},
		});

		expect(await runCollabStatus({ workspaceRoot })).toMatchObject({
			active: true,
			workspaceRoot,
		});

		expect(await runCollabStop({ workspaceRoot })).toMatchObject({
			stopped: true,
		});
	});
});
