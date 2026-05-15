import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../packages/companion-core/src/index.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";

describe("cli edge cases", () => {
	// Edge case 1: double start
	it("start throws if a collab is already active", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-edge-double-start-"),
		);

		await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
		});

		await expect(
			startCollabForTest({
				workspaceRoot,
				now: "2026-04-03T00:00:01.000Z",
				launchMode: "terminals",
			}),
		).rejects.toThrow(/active collab.*already exists/i);
	});

	// Edge case 2: tell with invalid target
	it("tell throws for an invalid target agent", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-edge-bad-target-"),
		);
		const planPath = join(workspaceRoot, "plan.md");
		writeFileSync(planPath, "# Plan\n");

		await startCollabForTest({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
		});

		await expect(
			runCollabTell({
				cwd: workspaceRoot,
				target: "gpt4o" as "codex" | "claude",
				instruction: "do something",
				artifactPaths: [],
				providerOverride: createMockProvider(),
				now: "2026-04-03T00:00:01.000Z",
			}),
		).rejects.toThrow(/invalid target|unknown.*target|target.*codex.*claude/i);
	});

	// Edge case 3: stop when no collab is active
	it("stop returns stopped:false when no collab is active", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-edge-stop-empty-"),
		);

		const result = await runCollabStop({ workspaceRoot });

		expect(result).toEqual({ stopped: false, message: "No active collab." });
	});

	// Edge case 4: status when no collab exists for cwd
	it("status returns a 'no active collab' message when shared DB has no collab for cwd", async () => {
		const tmp = mkdtempSync(join(tmpdir(), "ai-whisper-edge-no-collab-"));
		const prior = process.env.AI_WHISPER_STATE_ROOT;
		process.env.AI_WHISPER_STATE_ROOT = tmp;
		try {
			const result = await runCollabStatus({ cwd: tmp });
			expect(result).toContain("no active collab");
		} finally {
			if (prior !== undefined) {
				process.env.AI_WHISPER_STATE_ROOT = prior;
			} else {
				delete process.env.AI_WHISPER_STATE_ROOT;
			}
		}
	});
});
