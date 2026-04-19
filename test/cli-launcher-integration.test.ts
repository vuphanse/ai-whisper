import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { readCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { fakeBrokerSpawn, healthyBrokerAssess } from "./helpers/fake-broker-spawn.ts";

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
			assessBroker: healthyBrokerAssess,
			spawn: () => {},
		});

		expect(result).toMatchObject({
			collabId: expect.stringMatching(/^collab_/) as unknown,
			launchMode: "terminals",
			launched: true,
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

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "tmux",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker: healthyBrokerAssess,
			spawn: () => {},
			exec: () => {},
		});

		const state = readCliCollabState(getStateFilePath(workspaceRoot));
		expect(state?.launch.mode).toBe("tmux");
		expect(state?.launch.tmuxSession).toMatch(/^whisper-collab_/);
		// ownedSessions stays empty — mountedSessions is populated when mount
		// panes complete their attach claim.
		expect(state?.ownedSessions).toEqual({});
	});
});
