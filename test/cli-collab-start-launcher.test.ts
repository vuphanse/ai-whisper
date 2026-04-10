import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { fakeBrokerSpawn, healthyBrokerAssess } from "./helpers/fake-broker-spawn.ts";

describe("cli collab start launcher integration", () => {
	it("returns the chosen launch mode in the result", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-start-launcher-"),
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
		});
	});

	it("reports tmux as launch mode when specified", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-start-tmux-"));

		const result = await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "tmux",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker: healthyBrokerAssess,
			spawn: () => {},
			exec: () => {},
		});

		expect(result).toMatchObject({
			launchMode: "tmux",
		});
	});

	it("creates relay monitor pane in tmux layout", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-start-tmux-relay-"));
		const executedCommands: string[] = [];

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "tmux",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker: healthyBrokerAssess,
			spawn: () => {},
			exec: (cmd) => { executedCommands.push(cmd); },
		});

		// Should have a split-window -v for the relay monitor bottom pane
		const relayPaneCmd = executedCommands.find((cmd) => cmd.includes("relay-monitor"));
		expect(relayPaneCmd).toBeDefined();

		// Single relay pane only
		const relayPaneCmds = executedCommands.filter((cmd) => cmd.includes("relay-monitor"));
		expect(relayPaneCmds).toHaveLength(1);

		// Relay pane should be full-width vertical split at bottom
		expect(relayPaneCmd).toContain("split-window");
		expect(relayPaneCmd).toContain("-fv");
		expect(relayPaneCmd).toContain("-l 30%");
		expect(relayPaneCmd).toContain("AI_WHISPER_WORKSPACE_ROOT=");
	});
});
