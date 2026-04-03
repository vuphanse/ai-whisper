import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { readCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";

describe("cli launcher integration", () => {
	it("start returns launched session info with chosen launch mode", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-launcher-int-"),
		);

		const result = await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		expect(result).toMatchObject({
			collabId: expect.stringMatching(/^collab_/) as unknown,
			launchMode: "terminals",
			codexSessionId: expect.stringMatching(/^session_/) as unknown,
			claudeSessionId: expect.stringMatching(/^session_/) as unknown,
			launched: true,
		});
	});

	it("state file records the launch mode for each session", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-launcher-state-"),
		);

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "tmux",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		const state = readCliCollabState(getStateFilePath(workspaceRoot));
		expect(state?.sessions.codex.launchMode).toBe("tmux");
		expect(state?.sessions.claude.launchMode).toBe("tmux");
	});
});
