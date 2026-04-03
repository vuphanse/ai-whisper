import { createBrokerRuntime } from "@ai-whisper/broker";
import type { CompanionProvider, WorkItem } from "@ai-whisper/shared";
import { inferRequestedAction } from "../../runtime/action-inference.js";
import { normalizeArtifactPaths } from "../../runtime/artifact-input.js";
import { requiresExplicitArtifacts } from "../../runtime/context-policy.js";
import { createCliThreadId, createCliWorkItemId } from "../../runtime/id-factory.js";
import { getBrokerSqlitePath, getStateFilePath } from "../../runtime/paths.js";
import { readCliCollabState } from "../../runtime/state-file.js";
import { processOneTurn } from "../../runtime/on-demand-processing.js";
import { createProviderForTarget } from "../../runtime/providers.js";

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

  broker.control.enqueueWorkItem({
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

  const reply = await processOneTurn({
    broker,
    collabId: state.collabId,
    sessionId: targetSessionId,
    provider: input.providerOverride ?? createProviderForTarget(input.target),
    now: input.now,
  });

  await broker.stop();
  return reply;
}
