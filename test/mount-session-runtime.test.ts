import { describe, expect, it, vi } from "vitest";
import { createMountSessionRuntime } from "../packages/cli/src/runtime/mount-session-main.ts";
import { createCli } from "../packages/cli/src/create-cli.ts";
import type { CliCollabState } from "../packages/cli/src/runtime/state-file.ts";

describe("mount session runtime", () => {
	it("starts the live session before completing the claim and records mounted session metadata", async () => {
		const callOrder: string[] = [];
		const completeAttachClaim = vi.fn(() => ({
			collabId: "collab_mount",
			sessionId: "session_codex_mount",
			agentType: "codex",
		}));
		const liveSession = {
			start: () => {
				callOrder.push("live-start");
				return Promise.resolve();
			},
			stop: () => Promise.resolve(),
		};
		const fakeState: CliCollabState = {
			version: 5,
			collabId: "collab_mount",
			workspaceRoot: "/tmp/workspace",
			broker: { sqlitePath: "/tmp/broker.sqlite", host: "127.0.0.1", port: 4311, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: "2026-04-06T08:00:00.000Z",
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
			adoptedSessions: {},
			mountedSessions: {},
		};
		const updateState = vi.fn((_: string, update: (s: CliCollabState) => CliCollabState) =>
			update(fakeState),
		);

		const runtime = createMountSessionRuntime({
			target: "codex",
			ttyPath: "/dev/ttys031",
			workspaceRoot: "/tmp/workspace",
			claimId: "claim_mount_1",
			secret: "secret_mount",
			broker: {
				control: {
					completeAttachClaim,
					listSessionBindings: () => [],
					listSessions: () => [],
					markSessionDegraded: vi.fn(),
					getRelayTurnState: () => ({ collabId: "collab_mount", turnOwner: "none", waitingAgent: null, unresolvedHandoffId: null, handoffState: "idle", handoffAgeMs: null }),
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
			}),
			createLiveSession: () => liveSession as never,
			createProvider: () => ({
				getIdentity: () => ({ providerId: "codex-cli", toolFamily: "codex", providerVersion: "1.0.0" }),
				getCapabilities: () => ({
					supportsDirectPackets: true,
					supportsNormalization: false,
					supportsRelayInterception: true,
					supportsLocalBuffering: true,
					supportsLaunchHooks: false,
					extensions: {},
				}),
				getHealthState: () => "healthy" as const,
				handleWork: () => Promise.resolve({ kind: "answer" as const, content: "ok", transitionIntent: null }),
			}),
			updateState,
			runLoop: () => Promise.resolve(async () => {}),
		});

		await runtime.start();

		expect(callOrder).toEqual(["live-start"]);
		expect(completeAttachClaim).toHaveBeenCalledWith(expect.objectContaining({ bindingSource: "mounted" }));
		expect(updateState).toHaveBeenCalled();
	});
});

describe("mount session runtime — degradation on exit", () => {
	it("marks session degraded in the broker when the provider exits unexpectedly", async () => {
		const completeAttachClaim = vi.fn(() => ({
			collabId: "collab_mount",
			sessionId: "session_codex_mount",
			agentType: "codex",
		}));
		const markSessionDegraded = vi.fn();

		let capturedOnExit: (() => void) | null = null;
		const fakeState: CliCollabState = {
			version: 5,
			collabId: "collab_mount",
			workspaceRoot: "/tmp/workspace",
			broker: { sqlitePath: "/tmp/broker.sqlite", host: "127.0.0.1", port: 4311, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: "2026-04-06T08:00:00.000Z",
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
			adoptedSessions: {},
			mountedSessions: {},
		};

		const processExitCalls: number[] = [];
		const exitSpy = vi.spyOn(process, "exit").mockImplementation((code) => {
			processExitCalls.push(code as number);
			return undefined as never;
		});

		try {

			const runtime = createMountSessionRuntime({
				target: "codex",
				ttyPath: "/dev/ttys031",
				workspaceRoot: "/tmp/workspace",
				claimId: "claim_mount_1",
				secret: "secret_mount",
				broker: {
					control: {
						completeAttachClaim,
						listSessionBindings: () => [],
						listSessions: () => [],
						markSessionDegraded,
						getRelayTurnState: () => ({ collabId: "collab_mount", turnOwner: "none", waitingAgent: null, unresolvedHandoffId: null, handoffState: "idle", handoffAgeMs: null }),
						getRelayHandoff: () => null,
					},
					stop: () => Promise.resolve(),
				} as never,
				createInteractiveSession: () => ({
					start: () => Promise.resolve(),
					stop: () => Promise.resolve(),
					writeUserInput() {},
					sendLocalMessage() {},
					onExit(handler: () => void) { capturedOnExit = handler; },
				}),
				createLiveSession: () => ({ start: () => Promise.resolve(), stop: () => Promise.resolve() }) as never,
				createProvider: () => ({
					getIdentity: () => ({ providerId: "codex-cli", toolFamily: "codex", providerVersion: "1.0.0" }),
					getCapabilities: () => ({
						supportsDirectPackets: true,
						supportsNormalization: false,
						supportsRelayInterception: true,
						supportsLocalBuffering: true,
						supportsLaunchHooks: false,
						extensions: {},
					}),
					getHealthState: () => "healthy" as const,
					handleWork: () => Promise.resolve({ kind: "answer" as const, content: "ok", transitionIntent: null }),
				}),
				updateState: vi.fn((_: string, update: (s: CliCollabState) => CliCollabState) => update(fakeState)),
				runLoop: () => Promise.resolve(async () => {}),
			});

			await runtime.start();
			expect(capturedOnExit).not.toBeNull();

			// Simulate provider process exit
			capturedOnExit!();
			// Allow microtasks to flush
			await new Promise<void>((resolve) => setTimeout(resolve, 0));

			expect(markSessionDegraded).toHaveBeenCalledWith(
				expect.objectContaining({ sessionId: "session_codex_mount" }),
			);
		} finally {
			exitSpy.mockRestore();
		}
	});
});

describe("cli mount wiring", () => {
	it("registers the collab mount command", () => {
		const collab = createCli().commands.find((command) => command.name() === "collab");
		expect(collab?.commands.map((command) => command.name())).toContain("mount");
	});
});
