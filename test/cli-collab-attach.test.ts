import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { readCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
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

	it("throws when the role is already bound", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-attach-bound-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-05T13:30:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
		});

		const state = readCliCollabState(getStateFilePath(workspaceRoot))!;
		const broker = createBrokerRuntime({
			sqlitePath: state.broker.sqlitePath,
			host: state.broker.host,
			port: state.broker.port,
		});
		broker.control.registerSession({
			sessionId: "session_codex_existing",
			collabId: state.collabId,
			agentType: "codex",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now: "2026-04-05T13:31:00.000Z",
		});
		broker.control.setSessionBinding({
			collabId: state.collabId,
			agentType: "codex",
			sessionId: "session_codex_existing",
			bindingSource: "attached",
			now: "2026-04-05T13:31:00.000Z",
		});

		await expect(
			runCollabAttach({
				workspaceRoot,
				target: "codex",
				now: "2026-04-05T13:32:00.000Z",
			}),
		).rejects.toThrow(/rebind/i);
	});
});
