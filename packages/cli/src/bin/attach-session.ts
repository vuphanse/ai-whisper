#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createBrokerRuntime, type BrokerRuntime } from "@ai-whisper/broker";
import { createLiveSessionRuntime } from "../runtime/live-session.js";
import { runCompanionAgentLoop } from "../runtime/companion-agent-loop.js";
import {
	createAttachedInteractiveSessionForTarget,
	createProviderForTarget,
} from "../runtime/providers.js";
import {
	enqueueRelayWork,
	formatRelayAcknowledgement,
} from "../runtime/relay-service.js";
import { createContextInjector } from "../runtime/context-injector.js";
import { waitForReply } from "../runtime/reply-wait.js";
import { createCliSessionId } from "../runtime/id-factory.js";
import { readCliCollabState, updateCliCollabState } from "../runtime/state-file.js";
import { getStateFilePath } from "../runtime/paths.js";
import { createRelayPaneWriter } from "../runtime/relay-pane-writer.js";

export function createAttachSessionRuntime(input: {
	target: "codex" | "claude";
	workspaceRoot: string;
	claimId: string;
	secret: string;
	broker: BrokerRuntime;
	createProvider?: typeof createProviderForTarget;
	createInteractiveSession?: typeof createAttachedInteractiveSessionForTarget;
	createLiveSession?: typeof createLiveSessionRuntime;
	runLoop?: typeof runCompanionAgentLoop;
}) {
	return {
		async start() {
			const sessionId = createCliSessionId(input.target, new Date().toISOString());
			const provider = (input.createProvider ?? createProviderForTarget)(input.target);
			const interactiveSession = (input.createInteractiveSession ?? createAttachedInteractiveSessionForTarget)({
				target: input.target,
				stdin: process.stdin,
				stdout: process.stdout,
				cwd: process.cwd(),
			});

			const accepted = input.broker.control.completeAttachClaim({
				claimId: input.claimId,
				secret: input.secret,
				sessionId,
				provider: provider.getIdentity(),
				capabilities: provider.getCapabilities(),
				now: new Date().toISOString(),
				bindingSource: "attached",
			});

			// Clear idleAfterRecovery if this was a reconnect and state file exists
			const stateFilePath = getStateFilePath(input.workspaceRoot);
			try {
				updateCliCollabState(stateFilePath, (state) => {
					if (state.recovery.state !== "recovered") return state;

					const remainingDegraded = input.broker.control
						.listSessionBindings(accepted.collabId)
						.some((b) => {
							if (!b.activeSessionId) return false;
							const s = input.broker.control
								.listSessions(accepted.collabId)
								.find((sess) => sess.sessionId === b.activeSessionId);
							return s?.healthState !== "healthy";
						});

					return {
						...state,
						recovery: remainingDegraded
							? { ...state.recovery, idleAfterRecovery: false }
							: { state: "normal" as const, idleAfterRecovery: false, recoveredAt: null },
					};
				});
			} catch {
				// State file may not exist in test environments — not fatal
			}

			const relayPaneWriter = createRelayPaneWriter({ broker: input.broker, collabId: accepted.collabId });
			let activeRelayWorkItemId: string | null = null;
			const liveSession = (input.createLiveSession ?? createLiveSessionRuntime)({
				interactiveSession,
				stdin: process.stdin,
				stdout: process.stdout,
				relayPaneWriter,
				onRelayCancel: () => {
					if (!activeRelayWorkItemId) {
						return;
					}

					input.broker.control.requestWorkItemCancellation({
						workItemId: activeRelayWorkItemId,
						requestedAt: new Date().toISOString(),
					});
				},
				onRelay: async (directive, sendNow) => {
					if (directive.target === "pull") {
						const injector = createContextInjector({ broker: input.broker, collabId: accepted.collabId, sessionId: accepted.sessionId });
						const activeThread = input.broker.control.listThreads(accepted.collabId).find((t) => t.active);
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

					const contextInjector = createContextInjector({ broker: input.broker, collabId: accepted.collabId, sessionId: accepted.sessionId });

					relayPaneWriter.relayDirective({
						senderAgent: accepted.agentType,
						receiverAgent: directive.target,
						instruction: directive.instruction,
						now: new Date().toISOString(),
					});

					const relay = enqueueRelayWork({
						broker: input.broker,
						collabId: accepted.collabId,
						originSessionId: accepted.sessionId,
						target: directive.target,
						instruction: directive.instruction,
						artifactPaths: [],
						forceNewThread: directive.forceNewThread,
						now: new Date().toISOString(),
						contextInjector,
					});
					activeRelayWorkItemId = relay.workItem.workItemId;

					try {
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

						relayPaneWriter.relayResponse({
							senderAgent: directive.target,
							receiverAgent: accepted.agentType,
							content: reply.content,
							now: new Date().toISOString(),
						});
					} finally {
						activeRelayWorkItemId = null;
					}

					return null;
				},
			});

			let stopLoop = async () => {};
			let liveSessionStarted = false;
			let stopping = false;
			const onSignal = async () => {
				if (stopping) return;
				stopping = true;
				await stopLoop();
				if (liveSessionStarted) {
					await liveSession.stop();
				}
				await input.broker.stop();
				process.exit(0);
			};

			process.once("SIGINT", () => void onSignal());
			process.once("SIGTERM", () => void onSignal());

			try {
				await liveSession.start();
				liveSessionStarted = true;
				stopLoop = await (input.runLoop ?? runCompanionAgentLoop)({
					broker: input.broker,
					collabId: accepted.collabId,
					sessionId: accepted.sessionId,
					provider,
					interactiveSession,
					relayPaneWriter,
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

// CLI entry point — only runs when invoked directly
const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntryPoint) {
	const args = process.argv.slice(2);
	const target = args[0] as "codex" | "claude";
	const workspaceArgIdx = args.indexOf("--workspace");
	const claimIdArgIdx = args.indexOf("--claim-id");
	const secretArgIdx = args.indexOf("--secret");
	const workspaceRoot = workspaceArgIdx !== -1 ? args[workspaceArgIdx + 1] : undefined;
	const claimId = claimIdArgIdx !== -1 ? args[claimIdArgIdx + 1] : undefined;
	const secret = secretArgIdx !== -1 ? args[secretArgIdx + 1] : undefined;

	if (!target || !workspaceRoot || !claimId || !secret) {
		console.error("Usage: attach-session <codex|claude> --workspace <path> --claim-id <id> --secret <secret>");
		process.exit(1);
	}

	const state = readCliCollabState(getStateFilePath(workspaceRoot));
	if (!state) {
		console.error("No active collab found at the workspace root.");
		process.exit(1);
	}

	const broker = createBrokerRuntime({
		sqlitePath: state.broker.sqlitePath,
		host: state.broker.host,
		port: state.broker.port,
	});

	createAttachSessionRuntime({
		target,
		workspaceRoot,
		claimId,
		secret,
		broker,
	}).start().catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
}
