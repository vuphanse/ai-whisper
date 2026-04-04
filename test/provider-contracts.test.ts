import { describe, expect, it } from "vitest";
import {
	companionHeartbeatSchema,
	companionRegistrationSchema,
	createProviderIdentity,
	mockProviderReplySchema,
	providerCapabilitiesSchema,
} from "../packages/shared/src/index.ts";
import {
	createCodexLiveSession,
	createCodexProvider,
} from "../packages/adapter-codex/src/index.ts";
import {
	createClaudeLiveSession,
	createClaudeProvider,
} from "../packages/adapter-claude/src/index.ts";

describe("provider and companion contracts", () => {
	it("validates provider identity, capabilities, and companion registration payloads", () => {
		const provider = createProviderIdentity({
			providerId: "mock-provider",
			toolFamily: "mock-agent",
			providerVersion: "1.0.0",
		});

		expect(provider.providerId).toBe("mock-provider");

		expect(
			providerCapabilitiesSchema.parse({
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: false,
				supportsLocalBuffering: false,
				supportsLaunchHooks: false,
				extensions: {},
			}).supportsDirectPackets,
		).toBe(true);

		expect(
			companionRegistrationSchema.parse({
				version: 1,
				collabId: "collab_phase4",
				sessionId: "session_codex_1",
				provider,
				capabilities: {
					supportsDirectPackets: true,
					supportsNormalization: false,
					supportsRelayInterception: false,
					supportsLocalBuffering: false,
					supportsLaunchHooks: false,
					extensions: {},
				},
				registeredAt: "2026-04-03T00:00:00.000Z",
			}).sessionId,
		).toBe("session_codex_1");

		expect(
			companionHeartbeatSchema.parse({
				version: 1,
				collabId: "collab_phase4",
				sessionId: "session_codex_1",
				healthState: "healthy",
				sentAt: "2026-04-03T00:00:01.000Z",
			}).healthState,
		).toBe("healthy");

		expect(
			mockProviderReplySchema.parse({
				kind: "review",
				content: "Needs explicit retry handling.",
				transitionIntent: "awaiting_user",
			}).kind,
		).toBe("review");
	});

	it("builds real provider adapters with distinct identities", () => {
		expect(
			createCodexProvider({
				executable: "codex",
				execArgs: ["exec"],
			}).getIdentity().providerId,
		).toBe("openai-codex-cli");

		expect(
			createClaudeProvider({
				executable: "claude",
				execArgs: ["-p"],
			}).getIdentity().providerId,
		).toBe("anthropic-claude-cli");
	});

	it("providers support relay interception capability", () => {
		expect(
			createCodexProvider({ executable: "codex", execArgs: ["exec"] })
				.getCapabilities().supportsRelayInterception,
		).toBe(true);

		expect(
			createClaudeProvider({ executable: "claude", execArgs: ["-p"] })
				.getCapabilities().supportsRelayInterception,
		).toBe(true);
	});

	it("providers expose attachInteractiveSession", () => {
		expect(
			typeof createCodexProvider({ executable: "codex", execArgs: ["exec"] })
				.attachInteractiveSession,
		).toBe("function");

		expect(
			typeof createClaudeProvider({ executable: "claude", execArgs: ["-p"] })
				.attachInteractiveSession,
		).toBe("function");
	});

	it("live session factories are exported", () => {
		expect(typeof createCodexLiveSession).toBe("function");
		expect(typeof createClaudeLiveSession).toBe("function");
	});
});
