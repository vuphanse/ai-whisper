import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";

// Post-T14: runCollabStart no longer drives launchSessions. The CLI wrapper
// invokes the launcher separately after start returns. These tests now verify
// that runCollabStart's return shape carries the data the wrapper needs to
// drive the launcher (collabId / port / host / pid). Tmux pane spawning is
// covered by cli-launcher-real.test.ts directly against launchSessions.

describe("cli collab start launcher integration", () => {
	it("returns a collabId and broker connection info for terminals launch mode", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-start-launcher-"),
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
	});

	it("returns a collabId for tmux launch mode without invoking the launcher", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-start-tmux-"));

		const result = await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "tmux",
		});

		expect(result.collabId).toMatch(/^collab_/);
	});
});
