import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

describe("broker attach claims", () => {
	it("issues a pending attach claim and consumes it exactly once", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });
		runtime.control.startCollab({ collabId: "collab_attach", workspaceRoot: "/tmp/workspace", displayName: "attach", now: "2026-04-05T12:00:00.000Z" });

		const claim = runtime.control.issueAttachClaim({ collabId: "collab_attach", agentType: "codex", mode: "attach", now: "2026-04-05T12:00:00.000Z", expiresAt: "2026-04-05T12:05:00.000Z" });

		expect(claim.agentType).toBe("codex");
		expect(runtime.control.listSessionBindings("collab_attach")).toContainEqual(
			expect.objectContaining({ agentType: "codex", bindingState: "pending_attach", pendingClaimId: claim.claimId })
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
});
