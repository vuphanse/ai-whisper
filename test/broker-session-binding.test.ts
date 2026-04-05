import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

describe("broker session bindings", () => {
	it("keeps the old bound session authoritative until rebind completes", () => {
		const runtime = createBrokerRuntime({ sqlitePath: ":memory:", host: "127.0.0.1", port: 4311 });
		runtime.control.startCollab({ collabId: "collab_binding", workspaceRoot: "/tmp/workspace", displayName: "binding", now: "2026-04-05T12:10:00.000Z" });

		runtime.control.registerSession({
			sessionId: "session_codex_old", collabId: "collab_binding", agentType: "codex",
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T12:10:00.000Z",
		});
		runtime.control.setSessionBinding({ collabId: "collab_binding", agentType: "codex", sessionId: "session_codex_old", bindingSource: "launched", now: "2026-04-05T12:10:00.000Z" });

		const claim = runtime.control.issueAttachClaim({ collabId: "collab_binding", agentType: "codex", mode: "rebind", now: "2026-04-05T12:11:00.000Z", expiresAt: "2026-04-05T12:16:00.000Z" });

		expect(runtime.control.resolveBoundSession("collab_binding", "codex")).toBe("session_codex_old");

		runtime.control.completeAttachClaim({
			claimId: claim.claimId, secret: claim.secret, sessionId: "session_codex_new",
			provider: { providerId: "openai-codex-cli", toolFamily: "codex", providerVersion: "1.0.0" },
			capabilities: { supportsDirectPackets: true, supportsNormalization: false, supportsRelayInterception: true, supportsLocalBuffering: true, supportsLaunchHooks: false, extensions: {} },
			now: "2026-04-05T12:12:00.000Z", bindingSource: "attached",
		});

		expect(runtime.control.resolveBoundSession("collab_binding", "codex")).toBe("session_codex_new");
		expect(() => runtime.control.assertActiveBinding({ collabId: "collab_binding", sessionId: "session_codex_old" })).toThrow(/active binding/i);
	});

	it("old session remains assertable during pending_attach window", () => {
		const runtime = createBrokerRuntime({
			sqlitePath: ":memory:",
			host: "127.0.0.1",
			port: 4311,
		});

		runtime.control.startCollab({
			collabId: "collab_rebind_window",
			workspaceRoot: "/tmp/workspace",
			displayName: "rebind window",
			now: "2026-04-05T12:20:00.000Z",
		});

		runtime.control.registerSession({
			sessionId: "session_codex_window_old",
			collabId: "collab_rebind_window",
			agentType: "codex",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now: "2026-04-05T12:20:00.000Z",
		});
		runtime.control.setSessionBinding({
			collabId: "collab_rebind_window",
			agentType: "codex",
			sessionId: "session_codex_window_old",
			bindingSource: "launched",
			now: "2026-04-05T12:20:00.000Z",
		});

		const claim = runtime.control.issueAttachClaim({
			collabId: "collab_rebind_window",
			agentType: "codex",
			mode: "rebind",
			now: "2026-04-05T12:21:00.000Z",
			expiresAt: "2026-04-05T12:26:00.000Z",
		});

		// Old session is still assertable during pending_attach
		expect(() =>
			runtime.control.assertActiveBinding({
				collabId: "collab_rebind_window",
				sessionId: "session_codex_window_old",
			}),
		).not.toThrow();

		// Complete the rebind
		runtime.control.completeAttachClaim({
			claimId: claim.claimId,
			secret: claim.secret,
			sessionId: "session_codex_window_new",
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
			now: "2026-04-05T12:22:00.000Z",
			bindingSource: "attached",
		});

		// Now the old session is rejected
		expect(() =>
			runtime.control.assertActiveBinding({
				collabId: "collab_rebind_window",
				sessionId: "session_codex_window_old",
			}),
		).toThrow(/active binding/i);
	});
});
