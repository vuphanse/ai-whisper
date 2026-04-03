import { createBrokerRuntime } from "@ai-whisper/broker";
import type { CompanionProvider, WorkItem } from "@ai-whisper/shared";
import { inferRequestedAction } from "../../runtime/action-inference.js";
import { normalizeArtifactPaths } from "../../runtime/artifact-input.js";
import { requiresExplicitArtifacts } from "../../runtime/context-policy.js";
import { createCliThreadId, createCliWorkItemId } from "../../runtime/id-factory.js";
import { getBrokerSqlitePath, getStateFilePath } from "../../runtime/paths.js";
import { readCliCollabState } from "../../runtime/state-file.js";
import { processOneTurn } from "../../runtime/on-demand-processing.js";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function runCollabTell(input: {
  workspaceRoot: string;
  target: "codex" | "claude";
  instruction: string;
  explicitAction?: WorkItem["requestedAction"];
  artifactPaths: string[];
  threadTitle?: string;
  providerOverride?: CompanionProvider;
  now: string;
}) {
  if (input.target !== "codex" && input.target !== "claude") {
    throw new Error(
      `Invalid target "${String(input.target)}". Must be "codex" or "claude".`,
    );
  }

  const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
  if (!state) {
    throw new Error("No active collab. Run `whisper collab start` first.");
  }

  const broker = createBrokerRuntime({
    sqlitePath: getBrokerSqlitePath(input.workspaceRoot),
    host: state.broker.host,
    port: state.broker.port,
  });

  const action = input.explicitAction ?? inferRequestedAction(input.instruction);
  const artifactPaths = normalizeArtifactPaths(input.workspaceRoot, input.artifactPaths);
  const existingThread = broker.control.listThreads(state.collabId).find((thread) => thread.active);

  if (!existingThread && requiresExplicitArtifacts(action) && artifactPaths.length === 0) {
    throw new Error(`Action ${action} requires at least one --artifact on a new thread.`);
  }

  const senderSessionId = input.target === "codex" ? state.sessions.claude.sessionId : state.sessions.codex.sessionId;
  const targetSessionId = input.target === "codex" ? state.sessions.codex.sessionId : state.sessions.claude.sessionId;

  const thread = existingThread ?? broker.control.createThread({
    threadId: createCliThreadId(input.now),
    collabId: state.collabId,
    title: input.threadTitle ?? input.instruction,
    createdBySessionId: senderSessionId,
    now: input.now,
  });

  const workItem = broker.control.enqueueWorkItem({
    workItemId: createCliWorkItemId(input.now),
    threadId: thread.threadId,
    collabId: state.collabId,
    senderSessionId,
    targetSessionId,
    requestedAction: action,
    instruction: input.instruction,
    contextPacket: {
      kind: "full",
      goal: input.instruction,
      currentState: existingThread ? "Continuing active thread" : "New thread",
      decisionsMade: [],
      assumptions: [],
      relevantArtifacts: artifactPaths,
      openQuestions: [],
      successCriteria: [],
    },
    artifactManifestIds: [],
    now: input.now,
  });

  const reply = input.providerOverride
    ? await processOneTurn({
        broker,
        collabId: state.collabId,
        sessionId: targetSessionId,
        provider: input.providerOverride,
        now: input.now,
      })
    : await waitForCompanionReply({
        broker,
        threadId: thread.threadId,
        workItemId: workItem.workItemId,
      });

  await broker.stop();
  return reply;
}

async function waitForCompanionReply(input: {
  broker: ReturnType<typeof createBrokerRuntime>;
  threadId: string;
  workItemId: string;
}) {
  const timeoutAt = Date.now() + 15_000;

  while (Date.now() < timeoutAt) {
    const reply = input.broker.control
      .listReplies(input.threadId)
      .find((candidate) => candidate.workItemId === input.workItemId);

    if (reply) {
      return reply;
    }

    const workItem = input.broker.control.getWorkItem(input.workItemId);
    if (workItem?.deliveryState === "failed") {
      throw new Error(`Work item ${input.workItemId} failed without a reply payload.`);
    }

    await sleep(50);
  }

  throw new Error(`Timed out waiting for reply to work item ${input.workItemId}.`);
}
