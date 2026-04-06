import { Readable } from "node:stream";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createAdoptedInteractiveSession } from "../packages/cli/src/runtime/adopted-interactive-session.ts";
import { createAdoptSessionRuntime } from "../packages/cli/src/runtime/adopt-session-main.ts";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { readCliCollabState, writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";

describe("adopted interactive session", () => {
	it("writes user input and local messages to the adopted tty writer", async () => {
		const writes: string[] = [];
		const session = createAdoptedInteractiveSession({
			ttyPath: "/dev/ttys012",
			openTty: () => ({
				write(data: string) {
					writes.push(data);
				},
				close() {},
				onData() {},
			}),
		});

		await session.start();
		session.writeUserInput("hello");
		session.sendLocalMessage("[ai-whisper] ack\n");

		expect(writes).toEqual(["hello", "[ai-whisper] ack\n"]);
	});

	it("stop closes the tty handle", async () => {
		let closed = false;
		const session = createAdoptedInteractiveSession({
			ttyPath: "/dev/ttys012",
			openTty: () => ({
				write() {},
				close() {
					closed = true;
				},
				onData() {},
			}),
		});

		await session.start();
		await session.stop();

		expect(closed).toBe(true);
	});

	it("silently ignores writes before start", () => {
		const session = createAdoptedInteractiveSession({
			ttyPath: "/dev/ttys012",
			openTty: () => ({
				write() {
					throw new Error("should not be called");
				},
				close() {},
				onData() {},
			}),
		});

		// No start() called — these should be no-ops
		expect(() => session.writeUserInput("hello")).not.toThrow();
		expect(() => session.sendLocalMessage("msg")).not.toThrow();
	});
});

function buildMockProvider() {
	return {
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
}

function buildMockInteractiveSession() {
	return {
		start: vi.fn(async () => {}),
		stop: vi.fn(async () => {}),
		writeUserInput: vi.fn(),
		sendLocalMessage: vi.fn(),
	};
}

describe("adopt session runtime — deferred claim", () => {
	it("does not consume the attach claim when live session start fails", async () => {
		const completeAttachClaim = vi.fn();
		const broker = {
			control: { completeAttachClaim },
			stop: vi.fn(async () => {}),
		};

		const failingLiveSession = {
			start: vi.fn(() => Promise.reject(new Error("tty open failed"))),
			stop: vi.fn(() => Promise.resolve()),
		};

		const runtime = createAdoptSessionRuntime({
			target: "codex",
			ttyPath: "/dev/ttys012",
			workspaceRoot: "/tmp/workspace",
			claimId: "claim_123",
			secret: "secret_123",
			broker: broker as never,
			createProvider: () => buildMockProvider() as never,
			createInteractiveSession: () => buildMockInteractiveSession() as never,
			createLiveSession: () => failingLiveSession as never,
			runLoop: vi.fn(() => Promise.resolve(async () => {})),
		});

		await expect(runtime.start()).rejects.toThrow("tty open failed");
		expect(completeAttachClaim).not.toHaveBeenCalled();
	});

	it("consumes the attach claim only after live session start succeeds", async () => {
		const callOrder: string[] = [];
		const broker = {
			control: {
				completeAttachClaim: vi.fn(() => {
					callOrder.push("completeAttachClaim");
					return { sessionId: "session_1", collabId: "collab_1", agentType: "codex" };
				}),
			},
			stop: vi.fn(async () => {}),
		};

		const liveSession = {
			start: vi.fn(() => { callOrder.push("liveSession.start"); return Promise.resolve(); }),
			stop: vi.fn(() => Promise.resolve()),
		};

		const runtime = createAdoptSessionRuntime({
			target: "codex",
			ttyPath: "/dev/ttys012",
			workspaceRoot: "/tmp/workspace",
			claimId: "claim_123",
			secret: "secret_123",
			broker: broker as never,
			createProvider: () => buildMockProvider() as never,
			createInteractiveSession: () => buildMockInteractiveSession() as never,
			createLiveSession: () => liveSession as never,
			runLoop: vi.fn(() => Promise.resolve(async () => {})),
		});

		await runtime.start();

		expect(callOrder).toEqual(["liveSession.start", "completeAttachClaim"]);
	});

	it("uses a non-process-stdin readable for the live session", async () => {
		let capturedStdin: NodeJS.ReadableStream | undefined;
		const broker = {
			control: {
				completeAttachClaim: vi.fn(() => ({
					sessionId: "session_1",
					collabId: "collab_1",
					agentType: "codex",
				})),
			},
			stop: vi.fn(async () => {}),
		};

		const liveSession = {
			start: vi.fn(async () => {}),
			stop: vi.fn(async () => {}),
		};

		const runtime = createAdoptSessionRuntime({
			target: "codex",
			ttyPath: "/dev/ttys012",
			workspaceRoot: "/tmp/workspace",
			claimId: "claim_123",
			secret: "secret_123",
			broker: broker as never,
			createProvider: () => buildMockProvider() as never,
			createInteractiveSession: () => buildMockInteractiveSession() as never,
			createLiveSession: (input: { stdin: NodeJS.ReadableStream }) => {
				capturedStdin = input.stdin;
				return liveSession as never;
			},
			runLoop: vi.fn(() => Promise.resolve(async () => {})),
		});

		await runtime.start();

		expect(capturedStdin).toBeDefined();
		expect(capturedStdin).not.toBe(process.stdin);
		expect(capturedStdin).toBeInstanceOf(Readable);
	});
});

describe("adopt session runtime — recovery state clearing", () => {
	it("clears recovery state to normal after adopted reconnect when all bindings healthy", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-adopt-recovery-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const collabId = "collab_adopt_recovery";
		const now = "2026-04-06T18:00:00.000Z";

		// Set up broker with codex bound
		const setupBroker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4480 });
		setupBroker.control.startCollab({ collabId, workspaceRoot: dir, displayName: "adopt recovery", now });
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
			bindingSource: "adopted",
			now,
		});
		// Issue a reconnect claim
		setupBroker.control.issueAttachClaim({
			collabId,
			agentType: "codex",
			mode: "reconnect",
			now,
			expiresAt: new Date(Date.parse(now) + 5 * 60_000).toISOString(),
		});
		await setupBroker.stop();

		// Write state file with recovered state
		const statePath = join(dir, ".ai-whisper", "runtime", "current-collab.json");
		writeCliCollabState(statePath, {
			version: 5,
			collabId,
			workspaceRoot: dir,
			broker: { sqlitePath, host: "127.0.0.1", port: 4480, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: now,
			recovery: { state: "recovered", idleAfterRecovery: true, recoveredAt: now },
			adoptedSessions: {},
			mountedSessions: {},
		});

		// Get claim ID
		const readerBroker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4480 });
		const bindings = readerBroker.control.listSessionBindings(collabId);
		const codexBinding = bindings.find((b) => b.agentType === "codex");
		const claimId = codexBinding?.pendingClaimId;
		await readerBroker.stop();
		expect(claimId).toBeDefined();

		// Build a mock broker backed by real SQLite for listSessionBindings/listSessions
		const realBroker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4480 });
		const mockBroker = {
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

		const runtime = createAdoptSessionRuntime({
			target: "codex",
			ttyPath: "/dev/ttys012",
			workspaceRoot: dir,
			claimId: claimId!,
			secret: "fake_secret",
			broker: mockBroker as never,
			createProvider: () => buildMockProvider() as never,
			createInteractiveSession: () => buildMockInteractiveSession() as never,
			createLiveSession: () => ({
				start: vi.fn(async () => {}),
				stop: vi.fn(async () => {}),
			}) as never,
			runLoop: vi.fn(() => Promise.resolve(async () => {})),
		});

		await runtime.start();

		const updatedState = readCliCollabState(statePath);
		// All sessions report healthy (mocked completeAttachClaim returns healthy session),
		// and the real broker has no remaining degraded sessions for this simple setup
		expect(updatedState?.recovery.idleAfterRecovery).toBe(false);
	});
});
