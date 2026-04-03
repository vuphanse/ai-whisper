import type { BrokerRuntime } from "@ai-whisper/broker";
import type { CompanionProvider } from "@ai-whisper/shared";

export function createCompanionRuntime(input: {
  broker: BrokerRuntime;
  collabId: string;
  sessionId: string;
  provider: CompanionProvider;
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
        reply = await input.provider.handleWork({
          workItemId: workItem.workItemId,
          collabId: workItem.collabId,
          threadId: workItem.threadId,
          requestedAction: workItem.requestedAction,
          instruction: workItem.instruction,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const failReplyId = `reply_fail_${workItem.workItemId}_${now.replace(/[^0-9]/g, "")}`;

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
          now,
        });
      }

      const replyId = `reply_${workItem.workItemId}_${now.replace(/[^0-9]/g, "")}`;

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
        now,
      });
    },
  };
}
