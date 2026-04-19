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

	it("starts relay-monitor as the initial tmux pane so mount panes find it", async () => {
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

		// Single relay pane only
		const relayPaneCmds = executedCommands.filter((cmd) => cmd.includes("relay-monitor"));
		expect(relayPaneCmds).toHaveLength(1);

		// The relay pane is spawned as the initial tmux session so it heartbeats
		// before mount panes poll isRelayMonitorConnected().
		const initialSession = executedCommands.find((cmd) =>
			cmd.startsWith("tmux new-session"),
		);
		expect(initialSession).toBeDefined();
		expect(initialSession).toContain("relay-monitor");
		expect(initialSession).toContain("AI_WHISPER_WORKSPACE_ROOT=");

		// Mount panes are created via split-window after relay-monitor is up.
		const splits = executedCommands.filter((cmd) =>
			cmd.startsWith("tmux split-window"),
		);
		expect(splits.some((cmd) => cmd.includes("collab mount codex"))).toBe(true);
		expect(splits.some((cmd) => cmd.includes("collab mount claude"))).toBe(true);
	});
});
