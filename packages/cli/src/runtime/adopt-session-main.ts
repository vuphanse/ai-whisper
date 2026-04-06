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
	formatRelayReplySummary,
} from "./relay-service.js";
import { waitForReply } from "./reply-wait.js";
import { createCliSessionId } from "./id-factory.js";
import { updateCliCollabState } from "./state-file.js";
import { getStateFilePath } from "./paths.js";

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

			const accepted = input.broker.control.completeAttachClaim({
				claimId: input.claimId,
				secret: input.secret,
				sessionId,
				provider: provider.getIdentity(),
				capabilities: provider.getCapabilities(),
				now: new Date().toISOString(),
				bindingSource: "adopted",
			});

			const stateFilePath = getStateFilePath(input.workspaceRoot);
			try {
				(input.updateState ?? updateCliCollabState)(stateFilePath, (current) => ({
					...current,
					adoptedSessions: {
						...current.adoptedSessions,
						[input.target]: {
							agentType: input.target,
							ttyPath: input.ttyPath,
							daemonPid: process.pid,
						},
					},
				}));
			} catch {
				// State file may not exist in test environments — not fatal
			}

			const liveSession = (input.createLiveSession ?? createLiveSessionRuntime)({
				interactiveSession,
				stdin: process.stdin,
				stdout: process.stdout,
				onRelay: async (directive, sendNow) => {
					const relay = enqueueRelayWork({
						broker: input.broker,
						collabId: accepted.collabId,
						originSessionId: accepted.sessionId,
						target: directive.target,
						instruction: directive.instruction,
						artifactPaths: [],
						forceNewThread: directive.forceNewThread,
						now: new Date().toISOString(),
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

					return `${formatRelayReplySummary({
						target: directive.target,
						replyKind: reply.kind,
						content: reply.content,
					})}\n`;
				},
			});

			let stopLoop = async () => {};
			let liveSessionStarted = false;
			let stopping = false;
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
				await liveSession.start();
				liveSessionStarted = true;
				stopLoop = await (input.runLoop ?? runCompanionAgentLoop)({
					broker: input.broker,
					collabId: accepted.collabId,
					sessionId: accepted.sessionId,
					provider,
					interactiveSession,
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
