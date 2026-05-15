import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import { readCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";

describe("broker lifecycle", () => {
	it("start records broker PID in state file", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-broker-pid-"));

		await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
		});

		const state = readCliCollabState(getStateFilePath(workspaceRoot));
		expect(state?.broker.pid).toBeTypeOf("number");
		expect(state!.broker.pid).toBeGreaterThan(0);
	});

	it("stop kills the broker process and cleans up state", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-broker-stop-"),
		);

		await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
		});

		const result = await runCollabStop({
			workspaceRoot,
			killProcess: () => {},
			pidAlive: () => false,
			isPortFree: async () => true,
			findPortOwnerPid: () => null,
			sleep: async () => {},
		});
		expect(result.stopped).toBe(true);
		expect(readCliCollabState(getStateFilePath(workspaceRoot))).toBeNull();
	});
});
