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
import type { ProviderCapabilities, ProviderIdentity } from "../packages/shared/src/index.ts";

describe("cli collab attach", () => {
	it("issues a claim and renders a provider-specific snippet", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-attach-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-05T13:30:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
		});

		const result = runCollabAttach({
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

		expect(() =>
			runCollabAttach({
				workspaceRoot,
				target: "codex",
				now: "2026-04-05T13:32:00.000Z",
			}),
		).toThrow(/rebind/i);
	});

	it("session becomes bound after completeAttachClaim", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-attach-complete-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-05T14:00:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
		});

		const result = runCollabAttach({
			workspaceRoot,
			target: "codex",
			now: "2026-04-05T14:01:00.000Z",
		});

		const state = readCliCollabState(getStateFilePath(workspaceRoot))!;
		const broker = createBrokerRuntime({
			sqlitePath: state.broker.sqlitePath,
			host: state.broker.host,
			port: state.broker.port,
		});

		const provider: ProviderIdentity = {
			providerId: "openai-codex-cli",
			toolFamily: "codex",
			providerVersion: "1.0.0",
		};
		const capabilities: ProviderCapabilities = {
			supportsDirectPackets: true,
			supportsNormalization: false,
			supportsRelayInterception: true,
			supportsLocalBuffering: true,
			supportsLaunchHooks: false,
			extensions: {},
		};

		broker.control.completeAttachClaim({
			claimId: result.claim.claimId,
			secret: result.claim.secret,
			sessionId: "session_codex_attached",
			provider,
			capabilities,
			now: "2026-04-05T14:02:00.000Z",
			bindingSource: "attached",
		});

		const boundSessionId = broker.control.resolveBoundSession(state.collabId, "codex");
		expect(boundSessionId).toBe("session_codex_attached");
	});
});
