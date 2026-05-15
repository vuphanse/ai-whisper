import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";

describe("cli collab lifecycle", () => {
	it("starts a collab, reports status, and stops it", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-phase5-cli-"));

		await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
		});

		const status = await runCollabStatus({ cwd: workspaceRoot });
		expect(status).toContain("status: active");
		expect(status).toContain(`workspace: ${realpathSync(workspaceRoot)}`);

		await runCollabStop({
			cwd: workspaceRoot,
			now: () => "2026-04-03T00:01:00.000Z",
			signalProcess: () => {},
		});

		const stoppedStatus = await runCollabStatus({ cwd: workspaceRoot });
		expect(stoppedStatus).toContain("status: stopped");
	});
});
