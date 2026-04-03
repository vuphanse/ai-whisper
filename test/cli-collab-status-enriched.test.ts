import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../packages/companion-core/src/index.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabStatus } from "../packages/cli/src/commands/collab/status.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";

describe("cli collab status enriched", () => {
	it("includes activeThread when a thread exists", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-enriched-"),
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

		await runCollabTell({
			workspaceRoot,
			target: "codex",
			instruction: "review this plan",
			explicitAction: "review_plan",
			artifactPaths: [planPath],
			threadTitle: "Review plan",
			providerOverride: createMockProvider(),
			now: "2026-04-03T00:00:01.000Z",
		});

		const status = await runCollabStatus({ workspaceRoot });
		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.activeThread).toMatchObject({
				title: "Review plan",
			});
			expect(status.brokerHealth).toEqual({ ok: true });
		}
	});

	it("returns null activeThread and broker health when no thread exists", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-status-no-thread-"),
		);

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			spawn: () => {},
		});

		const status = await runCollabStatus({ workspaceRoot });
		expect(status.active).toBe(true);
		if (status.active) {
			expect(status.activeThread).toBeNull();
			expect(status.brokerHealth).toEqual({ ok: true });
		}
	});
});
