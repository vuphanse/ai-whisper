import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../packages/companion-core/src/index.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import {
	getBrokerSqlitePath,
	getStateFilePath,
} from "../packages/cli/src/runtime/paths.ts";
import { writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";

describe("cli edge cases", () => {
	// Edge case 1: double start
	it("start throws if a collab is already active", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-edge-double-start-"),
		);

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		await expect(
			runCollabStart({
				workspaceRoot,
				now: "2026-04-03T00:00:01.000Z",
				launchMode: "terminals",
				spawnBroker: fakeBrokerSpawn(),
				spawn: () => {},
			}),
		).rejects.toThrow(/collab.*already active|already.*collab/i);
	});

	// Edge case 2: tell with invalid target
	it("tell throws for an invalid target agent", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-edge-bad-target-"),
		);
		const planPath = join(workspaceRoot, "plan.md");
		writeFileSync(planPath, "# Plan\n");

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		await expect(
			runCollabTell({
				workspaceRoot,
				target: "gpt4o" as "codex" | "claude",
				instruction: "do something",
				artifactPaths: [],
				providerOverride: createMockProvider(),
				now: "2026-04-03T00:00:01.000Z",
			}),
		).rejects.toThrow(/invalid target|unknown.*target|target.*codex.*claude/i);
	});

	// Edge case 3: stop when no collab is active
	it("stop returns stopped:false when no collab is active", () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-edge-stop-empty-"),
		);

		const result = runCollabStop({ workspaceRoot });

		expect(result).toEqual({ stopped: false, message: "No active collab." });
	});

	// Edge case 4: status when broker sqlite is corrupted
	it("status returns active:false when broker sqlite is corrupted", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-edge-corrupt-db-"),
		);

		writeCliCollabState(getStateFilePath(workspaceRoot), {
			version: 1,
			collabId: "collab_20260403000000000",
			workspaceRoot,
			broker: {
				sqlitePath: getBrokerSqlitePath(workspaceRoot),
				host: "127.0.0.1",
				port: 4311,
				pid: 99999,
			},
			sessions: {
				codex: {
					sessionId: "session_codex_20260403000000000",
					providerId: "openai-codex-cli",
					launchMode: "terminals",
				},
				claude: {
					sessionId: "session_claude_20260403000000000",
					providerId: "anthropic-claude-cli",
					launchMode: "terminals",
				},
			},
			startedAt: "2026-04-03T00:00:00.000Z",
		});

		// Overwrite sqlite with invalid bytes
		writeFileSync(getBrokerSqlitePath(workspaceRoot), "not a sqlite file");

		const result = await runCollabStatus({ workspaceRoot });
		expect(result.active).toBe(false);
	});
});
