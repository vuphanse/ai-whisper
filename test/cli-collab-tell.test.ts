import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMockProvider } from "../packages/companion-core/src/index.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";
import { registerLaunchedBindings } from "./helpers/register-launched-bindings.ts";

const assessBroker = vi.fn(() => Promise.resolve({ pidAlive: true as const, httpReachable: true as const, ok: true as const }));

describe("cli collab tell", () => {
	it("routes a work request and returns a provider-backed reply", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-phase5-tell-"),
		);
		const planPath = join(workspaceRoot, "plan.md");
		writeFileSync(planPath, "# Plan\n");

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-03T00:00:00.000Z",
			launchMode: "terminals",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker,
			spawn: () => {},
		});
		// Default mode no longer pre-registers sessions — simulate bindings that
		// would normally be created by the mount panes once they complete.
		await registerLaunchedBindings({
			workspaceRoot,
			now: "2026-04-03T00:00:00.500Z",
		});

		await expect(
			runCollabTell({
				workspaceRoot,
				target: "codex",
				instruction: "review this plan",
				explicitAction: "review_plan",
				artifactPaths: [planPath],
				threadTitle: "Review plan",
				providerOverride: createMockProvider(),
				now: "2026-04-03T00:00:01.000Z",
				assessBroker,
			}),
		).resolves.toMatchObject({
			kind: "review",
		});
	});
});
