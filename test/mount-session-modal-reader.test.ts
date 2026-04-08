import { describe, expect, it, vi } from "vitest";

describe("mount session runtime — modal line reader", () => {
	it("does not create the modal line reader during mount startup", async () => {
		vi.resetModules();

		const createLocalModalLineReader = vi.fn(() => ({
			readLine: () => Promise.resolve(""),
			close() {},
		}));

		vi.doMock("../packages/cli/src/runtime/local-multiline-composer.ts", () => ({
			createLocalModalLineReader,
			createLocalMultilineComposer: vi.fn(),
		}));

		const { createMountSessionRuntime } = await import(
			"../packages/cli/src/runtime/mount-session-main.ts",
		);

		const runtime = createMountSessionRuntime({
			target: "codex",
			ttyPath: "/dev/ttys031",
			workspaceRoot: "/tmp/workspace",
			claimId: "claim_mount_1",
			secret: "secret_mount",
			broker: {
				control: {
					completeAttachClaim: () => ({
						collabId: "collab_mount",
						sessionId: "session_codex_mount",
						agentType: "codex",
					}),
					listSessionBindings: () => [],
					listSessions: () => [],
					markSessionDegraded: vi.fn(),
					getRelayTurnState: () => ({
						collabId: "collab_mount",
						turnOwner: "none",
						waitingAgent: null,
						unresolvedHandoffId: null,
						handoffState: "idle",
						handoffAgeMs: null,
					}),
					getRelayHandoff: () => null,
				},
				stop: () => Promise.resolve(),
			} as never,
			createInteractiveSession: () => ({
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
				writeUserInput() {},
				sendLocalMessage() {},
				onExit() {},
				onProviderOutput() {},
			}),
			createLiveSession: () => ({
				start: () => Promise.resolve(),
				stop: () => Promise.resolve(),
			}) as never,
			createProvider: () => ({
				getIdentity: () => ({
					providerId: "codex-cli",
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
				getHealthState: () => "healthy" as const,
				handleWork: () =>
					Promise.resolve({
						kind: "answer" as const,
						content: "ok",
						transitionIntent: null,
					}),
			}),
			updateState: vi.fn(),
			runLoop: () => Promise.resolve(async () => {}),
		});

		await runtime.start();

		expect(createLocalModalLineReader).not.toHaveBeenCalled();
	});
});
