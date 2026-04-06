import { Readable } from "node:stream";
import type { BrokerRuntime } from "@ai-whisper/broker";
import { createLiveSessionRuntime } from "./live-session.js";
import { runCompanionAgentLoop } from "./companion-agent-loop.js";
import {
	createAdoptedInteractiveSessionForTarget,
	createProviderForTarget,
} from "./providers.js";
import {
	enqueueRelayWork,
	formatRelayAcknowledgement,
} from "./relay-service.js";
import { createContextInjector } from "./context-injector.js";
import { waitForReply } from "./reply-wait.js";
import { createCliSessionId } from "./id-factory.js";
import { updateCliCollabState } from "./state-file.js";
import { getStateFilePath } from "./paths.js";
import { createRelayPaneWriter } from "./relay-pane-writer.js";

export function createAdoptSessionRuntime(input: {
	target: "codex" | "claude";
	ttyPath: string;
	workspaceRoot: string;
	claimId: string;
	secret: string;
	broker: BrokerRuntime;
	updateState?: typeof updateCliCollabState;
	createProvider?: typeof createProviderForTarget;
	createInteractiveSession?: typeof createAdoptedInteractiveSessionForTarget;
	createLiveSession?: typeof createLiveSessionRuntime;
	runLoop?: typeof runCompanionAgentLoop;
}) {
	return {
		async start() {
			const sessionId = createCliSessionId(input.target, new Date().toISOString());
			const provider = (input.createProvider ?? createProviderForTarget)(input.target);
			const interactiveSession = (input.createInteractiveSession ?? createAdoptedInteractiveSessionForTarget)({
				target: input.target,
				ttyPath: input.ttyPath,
			});

			// The adopted daemon runs detached with stdio: "ignore" (adopted-session-daemon.ts),
			// so process.stdin is /dev/null. Even if we opened the tty for reading, two processes
			// cannot reliably share a tty's read side on macOS — the foreground provider owns it
			// after `fg`. Use a never-emitting stream so the live-session runtime has a valid
			// stdin reference but never receives data. Inline @@ relay directives are not
			// available in adopted sessions; use `whisper collab tell` from another terminal.
			const adoptedStdin = new Readable({ read() {} });

			// Deferred claim — set after liveSession.start() proves the tty is accessible.
			let resolvedClaim: { collabId: string; sessionId: string; agentType: string } | null = null;
			// relayPaneWriter is created lazily once resolvedClaim is set (collabId is required).
			let relayPaneWriter: ReturnType<typeof createRelayPaneWriter> | null = null;
			const relayCancelHandle: { cancel: (() => void) | null } = { cancel: null };

			const liveSession = (input.createLiveSession ?? createLiveSessionRuntime)({
				interactiveSession,
				stdin: adoptedStdin,
				stdout: process.stdout,
				get relayPaneWriter() {
					return relayPaneWriter ?? undefined;
				},
				onRelayCancel: () => { relayCancelHandle.cancel?.(); },
				onRelay: async (directive, sendNow) => {
					if (!resolvedClaim) {
						throw new Error("Relay not available: session claim not yet completed");
					}

					if (directive.target === "pull") {
						const injector = createContextInjector({ broker: input.broker, collabId: resolvedClaim.collabId, sessionId: resolvedClaim.sessionId });
						const activeThread = input.broker.control.listThreads(resolvedClaim.collabId).find((t) => t.active);
						if (!activeThread) {
							sendNow("[ai-whisper] No active thread to pull context from.\n");
							return null;
						}
						const result = injector.injectContext({ userInput: "", activeThreadId: activeThread.threadId });
						if (result.injected) {
							interactiveSession.writeUserInput(result.payload);
							sendNow(`\u001b[2m↳ relay context attached (${result.summary})\u001b[0m\n`);
						} else {
							sendNow("[ai-whisper] No pending relay context to inject.\n");
						}
						return null;
					}

					const contextInjector = createContextInjector({ broker: input.broker, collabId: resolvedClaim.collabId, sessionId: resolvedClaim.sessionId });

					relayPaneWriter!.relayDirective({
						senderAgent: resolvedClaim.agentType,
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
						contextInjector,
					});

					sendNow(
						`${formatRelayAcknowledgement({
							target: directive.target,
							createdNewThread: relay.createdNewThread,
						})}\n`,
					);

					const reply = await waitForReply({
						broker: input.broker,
						threadId: relay.thread.threadId,
						workItemId: relay.workItem.workItemId,
					});

					relayPaneWriter!.relayResponse({
						senderAgent: directive.target,
						receiverAgent: resolvedClaim.agentType,
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
				try {
					(input.updateState ?? updateCliCollabState)(stateFilePath, (current) => {
						const nextAdoptedSessions = { ...current.adoptedSessions };
						delete nextAdoptedSessions[input.target];
						return {
							...current,
							adoptedSessions: nextAdoptedSessions,
						};
					});
				} catch {
					// State file cleanup is best-effort
				}
				await input.broker.stop();
			};

			process.once("SIGINT", () => void stop().then(() => process.exit(0)));
			process.once("SIGTERM", () => void stop().then(() => process.exit(0)));

			try {
				// Start the live session first — this opens the tty and proves it's accessible.
				// If this fails, the claim stays unconsumed and the binding remains in
				// pending_attach with the old session still active.
				await liveSession.start();
				liveSessionStarted = true;

				// Only now consume the claim and flip the binding to "bound".
				resolvedClaim = input.broker.control.completeAttachClaim({
					claimId: input.claimId,
					secret: input.secret,
					sessionId,
					provider: provider.getIdentity(),
					capabilities: provider.getCapabilities(),
					now: new Date().toISOString(),
					bindingSource: "adopted",
				});

				// Initialize the relay pane writer now that collabId is available.
				relayPaneWriter = createRelayPaneWriter({
					broker: input.broker,
					collabId: resolvedClaim.collabId,
				});

				// Update state file: record adopted session metadata + clear recovery state
				try {
					(input.updateState ?? updateCliCollabState)(stateFilePath, (current) => {
						let next = {
							...current,
							adoptedSessions: {
								...current.adoptedSessions,
								[input.target]: {
									agentType: input.target,
									ttyPath: input.ttyPath,
									daemonPid: process.pid,
								},
							},
						};

						// Clear recovery state if this was a reconnect (mirrors attach-session.ts:52-76)
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
				} catch {
					// State file may not exist in test environments — not fatal
				}

				stopLoop = await (input.runLoop ?? runCompanionAgentLoop)({
					broker: input.broker,
					collabId: resolvedClaim.collabId,
					sessionId: resolvedClaim.sessionId,
					provider,
					interactiveSession,
					relayPaneWriter: relayPaneWriter!,
					relayCancelHandle,
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
