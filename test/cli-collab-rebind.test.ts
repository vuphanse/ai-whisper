import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabRebind } from "../packages/cli/src/commands/collab/rebind.ts";
import { readCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";

describe("cli collab rebind", () => {
	it("requires replacement confirmation when stdin is interactive", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-rebind-"));
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
			sessionId: "session_claude_existing",
			collabId: state.collabId,
			agentType: "claude",
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
			agentType: "claude",
			sessionId: "session_claude_existing",
			bindingSource: "attached",
			now: "2026-04-05T13:31:00.000Z",
		});

		const prompts: string[] = [];
		await runCollabRebind({
			workspaceRoot,
			target: "claude",
			now: "2026-04-05T13:32:00.000Z",
			isInteractive: true,
			confirmReplace: async (message) => {
				prompts.push(message);
				return true;
			},
		});

		expect(prompts).toEqual([
			"Claude is already bound. Replace it? [y/N] ",
		]);
	});

	it("throws when non-interactive and --replace is not set", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-rebind-nointeractive-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-05T13:30:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
		});

		await expect(
			runCollabRebind({
				workspaceRoot,
				target: "claude",
				now: "2026-04-05T13:32:00.000Z",
				isInteractive: false,
			}),
		).rejects.toThrow(/--replace/i);
	});

	it("old session is no longer the active binding after rebind completes", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-rebind-stale-"));
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
			sessionId: "session_claude_original",
			collabId: state.collabId,
			agentType: "claude",
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
			agentType: "claude",
			sessionId: "session_claude_original",
			bindingSource: "attached",
			now: "2026-04-05T13:31:00.000Z",
		});

		// Execute rebind — issues a claim, putting the binding into pending_attach
		const result = await runCollabRebind({
			workspaceRoot,
			target: "claude",
			now: "2026-04-05T13:32:00.000Z",
			isInteractive: true,
			confirmReplace: async () => true,
		});

		// Complete the rebind by consuming the claim with a new session
		broker.control.completeAttachClaim({
			claimId: result.claim.claimId,
			secret: result.claim.secret,
			sessionId: "session_claude_replacement",
			provider: { providerId: "claude-code", toolFamily: "claude", providerVersion: "1.0.0" },
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now: "2026-04-05T13:33:00.000Z",
			bindingSource: "attached",
		});

		// The original session should no longer be the active binding
		expect(() =>
			broker.control.assertActiveBinding({
				collabId: state.collabId,
				sessionId: "session_claude_original",
			}),
		).toThrow(/active binding/i);

		// The new session should be the active binding
		expect(broker.control.resolveBoundSession(state.collabId, "claude")).toBe("session_claude_replacement");
	});
});
