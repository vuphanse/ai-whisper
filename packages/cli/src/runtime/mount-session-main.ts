import type { BrokerRuntime } from "@ai-whisper/broker";
import type { RelayDirective } from "@ai-whisper/shared";
import { createLiveSessionRuntime } from "./live-session.js";
import { runCompanionAgentLoop } from "./companion-agent-loop.js";
import {
	createInteractiveSessionForTarget,
	createProviderForTarget,
} from "./providers.js";
import { createContextInjector } from "./context-injector.js";
import { createCliSessionId } from "./id-factory.js";
import { updateCliCollabState } from "./state-file.js";
import { getStateFilePath } from "./paths.js";
import { createRelayPaneWriter } from "./relay-pane-writer.js";
import { createMountedTurnOwnedRelay } from "./mounted-turn-owned-relay.js";
import { createLocalMultilineComposer, createLocalModalLineReader } from "./local-multiline-composer.js";
import { createAssistantTurnCapture } from "./assistant-turn-capture.js";

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

			let ownerRefreshTimer: ReturnType<typeof setInterval> | null = null;
			let stopLoop = async () => {};
			let liveSessionStarted = false;
			let stopping = false;
			let closeLineReader = () => {};
			const stateFilePath = getStateFilePath(input.workspaceRoot);

			// liveSession is set after the collab claim resolves so collabId is available
			// for turnRelay, allowing externalInputGate to be passed directly instead of
			// via a lazy getter (spread evaluates getters once, freezing undefined at call time).
			let liveSession: ReturnType<typeof createLiveSessionRuntime> | null = null;

			const stop = async () => {
				if (stopping) return;
				stopping = true;
				if (ownerRefreshTimer !== null) {
					clearInterval(ownerRefreshTimer);
					ownerRefreshTimer = null;
				}
				closeLineReader();
				await stopLoop();
				if (liveSessionStarted && liveSession) {
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

			// resolvedClaim is needed in stop() and onRelay; hoist declaration above stop().
			let resolvedClaim: { collabId: string; sessionId: string; agentType: string } | null = null;

			process.once("SIGINT", () => void stop().then(() => process.exit(0)));
			process.once("SIGTERM", () => void stop().then(() => process.exit(0)));

			try {
				// Consume the claim to get collabId, which is needed for turnRelay and relayPaneWriter.
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
				const relayPaneWriter = createRelayPaneWriter({
					broker: input.broker,
					collabId: resolvedClaim.collabId,
				});

				// Initialize the turn-owned relay manager now that collabId is available.
				// Must happen before createLiveSessionRuntime so the waiting gate can be
				// passed directly — spread would evaluate the getter once at call time and
				// freeze it as undefined if turnRelay were still null.
				const lineReader = createLocalModalLineReader({
					stdin: process.stdin,
					stdout: process.stdout,
				});
				const readLine = lineReader.readLine;
				closeLineReader = lineReader.close;

				const turnCapture = createAssistantTurnCapture();
				interactiveSession.onProviderOutput?.((data: string) => {
					turnCapture.recordProviderOutput(data);
				});

				const turnRelay = createMountedTurnOwnedRelay({
					broker: input.broker,
					collabId: resolvedClaim.collabId,
					currentAgent: input.target,
					writeLocalMessage: (text) => interactiveSession.sendLocalMessage(text),
					writeUserInput: (text) => interactiveSession.writeUserInput(text),
					openComposer: async (args) => {
						const composer = createLocalMultilineComposer({
							prompt: args.prompt,
							initialValue: args.initialValue,
							writeLocalMessage: (text) => interactiveSession.sendLocalMessage(text),
							readLine,
						});
						return composer.run();
					},
					turnCapture,
				});

				const onRelay = async (
					directive: RelayDirective,
					sendNow: (message: string) => void,
				): Promise<string | null> => {
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

					relayPaneWriter.relayDirective({
						senderAgent: input.target,
						receiverAgent: directive.target,
						instruction: directive.instruction,
						now: new Date().toISOString(),
					});

					const handoffNow = new Date().toISOString();
					input.broker.control.createRelayHandoff({
						handoffId: `handoff_${handoffNow.replace(/[^0-9]/g, "")}`,
						collabId: resolvedClaim.collabId,
						senderAgent: input.target,
						targetAgent: directive.target,
						requestText: directive.instruction,
						now: handoffNow,
					});

					sendNow(`[ai-whisper] Handed turn to ${directive.target}.`);

					return null;
				};

				// Mounted sessions own the terminal; process.stdin is the real tty read side.
				// The live-session runtime intercepts inline @@ relay directives from stdin.
				liveSession = (input.createLiveSession ?? createLiveSessionRuntime)({
					interactiveSession,
					stdin: process.stdin,
					stdout: process.stdout,
					relayPaneWriter,
					externalInputGate: turnRelay.getWaitingGate(),
					onRelay,
				});

				// Start the live session — this launches the provider in the current terminal.
				await liveSession.start();
				liveSessionStarted = true;

				// Degrade if the provider exits unexpectedly (e.g. user Ctrl+C inside the provider,
				// or provider crashes). stop() is idempotent via the `stopping` guard.
				interactiveSession.onExit(() => {
					if (resolvedClaim && relayPaneWriter) {
						void turnRelay.handleOwnerDisconnect();
					}
					void stop().then(() => process.exit(0));
				});

				ownerRefreshTimer = setInterval(() => {
					void turnRelay.refreshOwnerView();
				}, 1000);
				await turnRelay.refreshOwnerView();

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
					relayPaneWriter,
				});
			} catch (err) {
				await stopLoop();
				if (liveSessionStarted && liveSession) {
					await liveSession.stop();
				}
				await input.broker.stop();
				throw err;
			}
		},
	};
}
