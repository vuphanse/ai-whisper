import { describe, expect, it, vi } from "vitest";
import { createAttachSessionRuntime } from "../packages/cli/src/bin/attach-session.ts";

describe("attach session runtime", () => {
	it("completes the claim, registers the companion, and starts the live loop", async () => {
		const provider = {
			getIdentity: () => ({
				providerId: "openai-codex-cli",
				toolFamily: "codex",
				providerVersion: "1.0.0",
			}),
			getCapabilities: () => ({
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			}),
		};
		const interactiveSession = {
			send: vi.fn(async () => {}),
			onOutput: vi.fn(),
			start: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
			writeUserInput: vi.fn(),
			sendLocalMessage: vi.fn(),
		};
		const liveSession = {
			start: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
		};
		const stopLoop = vi.fn(async () => {});

		const broker = {
			control: {
				completeAttachClaim: vi.fn(() => ({
					sessionId: "session_codex_attached",
					collabId: "collab_attach",
					agentType: "codex",
				})),
			},
			stop: vi.fn(async () => {}),
		};

		const runtime = createAttachSessionRuntime({
			target: "codex",
			workspaceRoot: "/tmp/workspace",
			claimId: "claim_123",
			secret: "secret_123",
			broker: broker as never,
			createProvider: () => provider as never,
			createInteractiveSession: () => interactiveSession as never,
			createLiveSession: () => liveSession as never,
			runLoop: vi.fn(() => Promise.resolve(stopLoop)),
		});

		await runtime.start();

		expect(broker.control.completeAttachClaim).toHaveBeenCalledWith(
			expect.objectContaining({
				claimId: "claim_123",
				secret: "secret_123",
			}),
		);
		expect(liveSession.start).toHaveBeenCalledTimes(1);
	});
});
