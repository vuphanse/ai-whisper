import type { BrokerRuntime } from "@ai-whisper/broker";
import type { CompanionProvider, ProviderReply, ProviderWorkRequest } from "@ai-whisper/shared";

export function createCompanionRuntime(input: {
	broker: BrokerRuntime;
	collabId: string;
	sessionId: string;
	provider: CompanionProvider;
	executor?: (request: ProviderWorkRequest) => Promise<ProviderReply>;
}) {
	let sessionSecret: string | null = null;

	return {
		register(now: string) {
			const ack = input.broker.control.registerCompanion({
				collabId: input.collabId,
				sessionId: input.sessionId,
				provider: input.provider.getIdentity(),
				capabilities: input.provider.getCapabilities(),
				now,
			});

			sessionSecret = ack.sessionSecret;
			return ack;
		},
		heartbeat(now: string) {
			if (!sessionSecret) {
				throw new Error("Companion runtime is not registered");
			}

			input.broker.control.recordCompanionHeartbeat({
				collabId: input.collabId,
				sessionId: input.sessionId,
				sessionSecret,
				healthState: input.provider.getHealthState(),
				now,
			});
		},
		async processNext(now: string) {
			if (!sessionSecret) {
				throw new Error("Companion runtime is not registered");
			}

			const workItem = input.broker.control.pollQueuedWorkItem({
				collabId: input.collabId,
				sessionId: input.sessionId,
				sessionSecret,
			});

			if (!workItem) {
				return null;
			}

			input.broker.control.ackWorkItemDelivered({
				workItemId: workItem.workItemId,
				deliveredAt: now,
			});

			let reply;
			try {
				// No artifact context when no executor is configured (one-shot path)
				const doWork = input.executor ?? ((req) => input.provider.handleWork(req));
				const request: ProviderWorkRequest = {
					workItemId: workItem.workItemId,
					collabId: workItem.collabId,
					threadId: workItem.threadId,
					requestedAction: workItem.requestedAction,
					instruction: workItem.instruction,
				};
				reply = await doWork(request);
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				const replyNow = new Date().toISOString();
				const failReplyId = `reply_fail_${workItem.workItemId}_${replyNow.replace(/[^0-9]/g, "")}`;

				return input.broker.control.postReply({
					replyId: failReplyId,
					threadId: workItem.threadId,
					collabId: workItem.collabId,
					workItemId: workItem.workItemId,
					sourceSessionId: input.sessionId,
					kind: "failure",
					content: `Provider error: ${message}`,
					transitionIntent: "failed",
					artifactManifestIds: [],
					now: replyNow,
				});
			}

			const replyNow = new Date().toISOString();
			const replyId = `reply_${workItem.workItemId}_${replyNow.replace(/[^0-9]/g, "")}`;

			return input.broker.control.postReply({
				replyId,
				threadId: workItem.threadId,
				collabId: workItem.collabId,
				workItemId: workItem.workItemId,
				sourceSessionId: input.sessionId,
				kind: reply.kind,
				content: reply.content,
				transitionIntent: reply.transitionIntent,
				artifactManifestIds: [],
				now: replyNow,
			});
		},
	};
}
