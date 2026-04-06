import { describe, expect, it, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAttachSessionRuntime } from "../packages/cli/src/bin/attach-session.ts";
import { readCliCollabState, writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

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

	it("clears idleAfterRecovery on successful reconnect attach-session completion", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-attach-reconnect-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const collabId = "collab_attach_reconnect";
		const now = "2026-04-05T18:00:00.000Z";

		// Set up a real broker with a bound session
		const setupBroker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4420 });
		setupBroker.control.startCollab({ collabId, workspaceRoot: dir, displayName: "reconnect test", now });
		setupBroker.control.registerSession({
			sessionId: "session_codex_reconn",
			collabId,
			agentType: "codex",
			capabilities: {
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: true,
				supportsLocalBuffering: true,
				supportsLaunchHooks: false,
				extensions: {},
			},
			now,
		});
		setupBroker.control.setSessionBinding({
			collabId,
			agentType: "codex",
			sessionId: "session_codex_reconn",
			bindingSource: "attached",
			now,
		});
		// Issue a reconnect claim so completeAttachClaim can be called
		setupBroker.control.issueAttachClaim({
			collabId,
			agentType: "codex",
			mode: "reconnect",
			now,
			expiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
		});
		await setupBroker.stop();

		// Write state file with recovery.state === "recovered", idleAfterRecovery === true
		const runtimeDir = join(dir, ".ai-whisper", "runtime");
		const statePath = join(runtimeDir, "current-collab.json");
		writeCliCollabState(statePath, {
			version: 4,
			collabId,
			workspaceRoot: dir,
			broker: { sqlitePath, host: "127.0.0.1", port: 4420, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: { state: "recovered", idleAfterRecovery: true, recoveredAt: now },
			adoptedSessions: {},
		});

		// Get the claim ID that was issued
		const readerBroker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4420 });
		const bindings = readerBroker.control.listSessionBindings(collabId);
		const codexBinding = bindings.find((b) => b.agentType === "codex");
		const claimId = codexBinding?.pendingClaimId;
		await readerBroker.stop();

		expect(claimId).toBeDefined();

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

		// We can't use the real broker because we don't know the secret.
		// Use a mocked broker that simulates completeAttachClaim success and real session bindings
		// Then check the state file update separately.
		// Approach: use a mocked broker but with real listSessionBindings/listSessions.
		const mockBrokerForReconnect = (() => {
			const realBroker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4420 });
			return {
				control: {
					completeAttachClaim: vi.fn(() => ({
						sessionId: "session_codex_reconn_new",
						collabId,
						agentType: "codex" as const,
					})),
					listSessionBindings: realBroker.control.listSessionBindings.bind(realBroker.control),
					listSessions: realBroker.control.listSessions.bind(realBroker.control),
				},
				stop: vi.fn(async () => { await realBroker.stop(); }),
			};
		})();

		const runtime2 = createAttachSessionRuntime({
			target: "codex",
			workspaceRoot: dir,
			claimId: "claim_fake",
			secret: "secret_fake",
			broker: mockBrokerForReconnect as never,
			createProvider: () => provider as never,
			createInteractiveSession: () => interactiveSession as never,
			createLiveSession: () => liveSession as never,
			runLoop: vi.fn(() => Promise.resolve(stopLoop)),
		});

		await runtime2.start();

		// Read the state file back and assert idleAfterRecovery was cleared
		const updatedState = readCliCollabState(statePath);
		expect(updatedState?.recovery.idleAfterRecovery).toBe(false);
	});
});
