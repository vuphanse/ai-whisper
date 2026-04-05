import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabAttach } from "../packages/cli/src/commands/collab/attach.ts";

describe("cli collab attach", () => {
	it("issues a claim and renders a provider-specific snippet", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-attach-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-05T13:30:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
		});

		const result = await runCollabAttach({
			workspaceRoot,
			target: "codex",
			now: "2026-04-05T13:31:00.000Z",
		});

		expect(result.claim.agentType).toBe("codex");
		expect(result.snippet).toContain("attach-session");
		expect(result.snippet).toContain("codex");
	});
});
