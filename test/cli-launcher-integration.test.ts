import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";

describe("cli launcher integration", () => {
	it("start returns broker connection info for the chosen launch mode", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-launcher-int-"),
		);

		const result = await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
		});

		expect(result).toMatchObject({
			collabId: expect.stringMatching(/^collab_/) as unknown,
			host: "127.0.0.1",
			port: expect.any(Number) as number,
			pid: expect.any(Number) as number,
		});
		// Start no longer pre-registers sessions — mount runtime binds them when
		// the mount panes finish claiming their TTY.
		expect(result).not.toHaveProperty("codexSessionId");
		expect(result).not.toHaveProperty("claudeSessionId");
	});

	it("state file records the launch mode and broker info with empty ownedSessions", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-launcher-state-"),
		);

		await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "tmux",
		});

		const state = readCliCollabState(getStateFilePath(workspaceRoot));
		expect(state?.launch?.mode).toBe("tmux");
		expect(state?.launch?.tmuxSession).toMatch(/^whisper-collab_/);
		// ownedSessions stays empty — mountedSessions is populated when mount
		// panes complete their attach claim.
		expect(state?.ownedSessions).toEqual({});
	});
});
