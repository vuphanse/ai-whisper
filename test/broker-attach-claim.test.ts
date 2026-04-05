import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

describe("broker attach claims", () => {
	it("issues a pending attach claim and consumes it exactly once", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });
		runtime.control.startCollab({ collabId: "collab_attach", workspaceRoot: "/tmp/workspace", displayName: "attach", now: "2026-04-05T12:00:00.000Z" });

		const claim = runtime.control.issueAttachClaim({ collabId: "collab_attach", agentType: "codex", mode: "attach", now: "2026-04-05T12:00:00.000Z", expiresAt: "2026-04-05T12:05:00.000Z" });

		expect(claim.agentType).toBe("codex");
		expect(runtime.control.listSessionBindings("collab_attach")).toContainEqual(
			expect.objectContaining({ agentType: "codex", bindingState: "pending_attach", pendingClaimId: claim.claimId }),
		);

		const accepted = runtime.control.completeAttachClaim({
			claimId: claim.claimId, secret: claim.secret, sessionId: "session_codex_attached",
			provider: { providerId: "openai-codex-cli", toolFamily: "codex", providerVersion: "1.0.0" },
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T12:01:00.000Z", bindingSource: "attached",
		});
		expect(accepted.sessionId).toBe("session_codex_attached");

		expect(() => runtime.control.completeAttachClaim({
			claimId: claim.claimId, secret: claim.secret, sessionId: "session_codex_second_try",
			provider: accepted.provider, capabilities: accepted.capabilities,
			now: "2026-04-05T12:02:00.000Z", bindingSource: "attached",
		})).toThrow(/consumed/i);
	});

	it("rejects a foreign session id whose collab or agentType does not match the claim", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });
		runtime.control.startCollab({ collabId: "collab_a", workspaceRoot: "/tmp/a", displayName: "a", now: "2026-04-05T12:00:00.000Z" });
		runtime.control.startCollab({ collabId: "collab_b", workspaceRoot: "/tmp/b", displayName: "b", now: "2026-04-05T12:00:00.000Z" });

		// Register a session belonging to collab_a / codex
		runtime.control.registerSession({
			sessionId: "session_collab_a_codex",
			collabId: "collab_a",
			agentType: "codex",
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T12:00:00.000Z",
		});

		// Issue a claim for collab_b / claude
		const claim = runtime.control.issueAttachClaim({ collabId: "collab_b", agentType: "claude", mode: "attach", now: "2026-04-05T12:00:00.000Z", expiresAt: "2026-04-05T12:05:00.000Z" });

		// Attempt to complete the claim reusing the foreign session id
		expect(() => runtime.control.completeAttachClaim({
			claimId: claim.claimId, secret: claim.secret, sessionId: "session_collab_a_codex",
			provider: { providerId: "anthropic-claude-cli", toolFamily: "claude", providerVersion: "1.0.0" },
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T12:01:00.000Z", bindingSource: "attached",
		})).toThrow(/collab/i);
	});

	it("rejects a malformed provider payload before mutating broker state", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });
		runtime.control.startCollab({ collabId: "collab_malformed", workspaceRoot: "/tmp/m", displayName: "m", now: "2026-04-05T12:00:00.000Z" });
		const claim = runtime.control.issueAttachClaim({ collabId: "collab_malformed", agentType: "codex", mode: "attach", now: "2026-04-05T12:00:00.000Z", expiresAt: "2026-04-05T12:05:00.000Z" });

		expect(() => runtime.control.completeAttachClaim({
			claimId: claim.claimId, secret: claim.secret, sessionId: "session_codex_malformed",
			provider: { providerId: "", toolFamily: "codex", providerVersion: "1.0.0" } as never, // empty providerId fails Zod min(1)
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T12:01:00.000Z", bindingSource: "attached",
		})).toThrow();

		// Claim must still be pending — state was not mutated
		expect(() => runtime.control.completeAttachClaim({
			claimId: claim.claimId, secret: claim.secret, sessionId: "session_codex_malformed",
			provider: { providerId: "openai-codex-cli", toolFamily: "codex", providerVersion: "1.0.0" },
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T12:02:00.000Z", bindingSource: "attached",
		})).not.toThrow();
	});

	it("rejects a claim after it has expired", () => {
		const runtime = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4311,
		});

		runtime.control.startCollab({
			collabId: "collab_expired",
			workspaceRoot: "/tmp/workspace",
			displayName: "expired",
			now: "2026-04-05T12:00:00.000Z",
		});

		const claim = runtime.control.issueAttachClaim({
			collabId: "collab_expired",
			agentType: "codex",
			mode: "attach",
			now: "2026-04-05T12:00:00.000Z",
			expiresAt: "2026-04-05T12:05:00.000Z",
		});

		expect(() =>
			runtime.control.completeAttachClaim({
				claimId: claim.claimId,
				secret: claim.secret,
				sessionId: "session_codex_late",
				provider: {
					providerId: "openai-codex-cli",
					toolFamily: "codex",
					providerVersion: "1.0.0",
				},
				capabilities: {
					supportsDirectPackets: true,
					supportsNormalization: false,
					supportsRelayInterception: true,
					supportsLocalBuffering: true,
					supportsLaunchHooks: false,
					extensions: {},
				},
				now: "2026-04-05T12:10:00.000Z", // after expiresAt
				bindingSource: "attached",
			}),
		).toThrow(/expired/i);
	});
});
