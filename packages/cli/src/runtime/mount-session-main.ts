import type { BrokerRuntime } from "@ai-whisper/broker";
import { createLiveSessionRuntime } from "./live-session.js";
import { runCompanionAgentLoop } from "./companion-agent-loop.js";
import {
	createInteractiveSessionForTarget,
	createProviderForTarget,
} from "./providers.js";
import {
	enqueueRelayWork,
	formatRelayAcknowledgement,
} from "./relay-service.js";
import { waitForReply } from "./reply-wait.js";
import { createCliSessionId } from "./id-factory.js";
import { updateCliCollabState } from "./state-file.js";
import { getStateFilePath } from "./paths.js";
import { createRelayPaneWriter } from "./relay-pane-writer.js";

export function createMountSessionRuntime(input: {
	target: "codex" | "claude";
	ttyPath: string;
	workspaceRoot: string;
	claimId: string;
	secret: string;
	broker: BrokerRuntime;
	updateState?: typeof updateCliCollabState;
	createProvider?: typeof createProviderForTarget;
	createInteractiveSession?: typeof createInteractiveSessionForTarget;
	createLiveSession?: typeof createLiveSessionRuntime;
	runLoop?: typeof runCompanionAgentLoop;
}) {
	return {
		async start() {
			const sessionId = createCliSessionId(input.target, new Date().toISOString());
			const provider = (input.createProvider ?? createProviderForTarget)(input.target);
			const interactiveSession = (input.createInteractiveSession ?? createInteractiveSessionForTarget)({
				target: input.target,
				cwd: input.workspaceRoot,
				stdout: process.stdout,
			});

			// Deferred claim — set after liveSession.start() proves the provider launched cleanly.
			// onRelay guards against null so there is no race between relay arrival and claim completion.
			let resolvedClaim: { collabId: string; sessionId: string; agentType: string } | null = null;
			// relayPaneWriter is created lazily once resolvedClaim is set (collabId is required).
			let relayPaneWriter: ReturnType<typeof createRelayPaneWriter> | null = null;

			// Mounted sessions own the terminal; process.stdin is the real tty read side.
			// The live-session runtime intercepts inline @@ relay directives from stdin.
			const liveSession = (input.createLiveSession ?? createLiveSessionRuntime)({
				interactiveSession,
				stdin: process.stdin,
				stdout: process.stdout,
				get relayPaneWriter() {
					return relayPaneWriter ?? undefined;
				},
				onRelay: async (directive, sendNow) => {
					if (!resolvedClaim) {
						throw new Error("Relay not available: session claim not yet completed");
					}

					const writer = relayPaneWriter!;

					writer.relayDirective({
						senderAgent: input.target,
						receiverAgent: directive.target,
						instruction: directive.instruction,
						now: new Date().toISOString(),
					});

					const relay = enqueueRelayWork({
						broker: input.broker,
						collabId: resolvedClaim.collabId,
						originSessionId: resolvedClaim.sessionId,
						target: directive.target,
						instruction: directive.instruction,
						artifactPaths: [],
						forceNewThread: directive.forceNewThread,
						now: new Date().toISOString(),
					});

					sendNow(
						formatRelayAcknowledgement({
							target: directive.target,
							createdNewThread: relay.createdNewThread,
						}),
					);

					const reply = await waitForReply({
						broker: input.broker,
						threadId: relay.thread.threadId,
						workItemId: relay.workItem.workItemId,
					});

					writer.relayResponse({
						senderAgent: directive.target,
						receiverAgent: input.target,
						content: reply.content,
						now: new Date().toISOString(),
					});

					return null;
				},
			});

			let stopLoop = async () => {};
			let liveSessionStarted = false;
			let stopping = false;
			const stateFilePath = getStateFilePath(input.workspaceRoot);

			const stop = async () => {
				if (stopping) return;
				stopping = true;
				await stopLoop();
				if (liveSessionStarted) {
					await liveSession.stop();
				}
				// Mark the session degraded before stopping the broker so status/inspect
				// correctly reflect that the mounted provider is no longer running.
				if (resolvedClaim) {
					try {
						input.broker.control.markSessionDegraded({
							sessionId: resolvedClaim.sessionId,
							now: new Date().toISOString(),
						});
					} catch {
						// Best-effort; broker may already be unreachable.
					}
				}
				try {
					(input.updateState ?? updateCliCollabState)(stateFilePath, (current) => {
						const nextMountedSessions = { ...current.mountedSessions };
						delete nextMountedSessions[input.target];
						return {
							...current,
							mountedSessions: nextMountedSessions,
						};
					});
				} catch {
					// State cleanup is best-effort.
				}
				await input.broker.stop();
			};

			process.once("SIGINT", () => void stop().then(() => process.exit(0)));
			process.once("SIGTERM", () => void stop().then(() => process.exit(0)));

			try {
				// Start the live session first — this launches the provider in the current terminal.
				// If this fails, the claim stays unconsumed and the binding remains in pending_attach.
				await liveSession.start();
				liveSessionStarted = true;

				// Degrade if the provider exits unexpectedly (e.g. user Ctrl+C inside the provider,
				// or provider crashes). stop() is idempotent via the `stopping` guard.
				interactiveSession.onExit(() => void stop().then(() => process.exit(0)));

				// Only now consume the claim and flip the binding to "bound".
				resolvedClaim = input.broker.control.completeAttachClaim({
					claimId: input.claimId,
					secret: input.secret,
					sessionId,
					provider: provider.getIdentity(),
					capabilities: provider.getCapabilities(),
					now: new Date().toISOString(),
					bindingSource: "mounted",
				});

				// Initialize the relay pane writer now that collabId is available.
				relayPaneWriter = createRelayPaneWriter({
					broker: input.broker,
					collabId: resolvedClaim.collabId,
				});

				// Update state file: record mounted session metadata + clear recovery state.
				(input.updateState ?? updateCliCollabState)(stateFilePath, (current) => {
					let next = {
						...current,
						mountedSessions: {
							...current.mountedSessions,
							[input.target]: {
								agentType: input.target,
								ttyPath: input.ttyPath,
								sessionPid: process.pid,
							},
						},
					};

					// Clear recovery state if this was a reconnect (mirrors attach-session.ts pattern).
					if (next.recovery.state === "recovered") {
						const remainingDegraded = input.broker.control
							.listSessionBindings(resolvedClaim!.collabId)
							.some((b) => {
								if (!b.activeSessionId) return false;
								const s = input.broker.control
									.listSessions(resolvedClaim!.collabId)
									.find((sess) => sess.sessionId === b.activeSessionId);
								return s?.healthState !== "healthy";
							});

						next = {
							...next,
							recovery: remainingDegraded
								? { ...next.recovery, idleAfterRecovery: false }
								: { state: "normal" as const, idleAfterRecovery: false, recoveredAt: null },
						};
					}

					return next;
				});

				stopLoop = await (input.runLoop ?? runCompanionAgentLoop)({
					broker: input.broker,
					collabId: resolvedClaim.collabId,
					sessionId: resolvedClaim.sessionId,
					provider,
					interactiveSession,
					relayPaneWriter: relayPaneWriter!,
				});
			} catch (err) {
				await stopLoop();
				if (liveSessionStarted) {
					await liveSession.stop();
				}
				await input.broker.stop();
				throw err;
			}
		},
	};
}
