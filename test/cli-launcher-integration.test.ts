import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDatabase } from "@ai-whisper/broker";
import { getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";
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

	it("shared DB records the launch mode for the collab", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-launcher-state-"),
		);

		const result = await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "tmux",
			tmuxSession: `whisper-${"collab_launcher"}`,
		});

		const db = openDatabase(getSharedSqlitePath());
		try {
			const row = db
				.prepare(
					"SELECT launch_mode, tmux_session FROM collab WHERE collab_id = ?",
				)
				.get(result.collabId) as
				| { launch_mode: string; tmux_session: string | null }
				| undefined;
			expect(row?.launch_mode).toBe("tmux");
			expect(row?.tmux_session).toMatch(/^whisper-/);
		} finally {
			db.close();
		}
	});
});
