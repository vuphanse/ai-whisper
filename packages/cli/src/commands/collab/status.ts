import { createBrokerRuntime } from "@ai-whisper/broker";
import { getBrokerSqlitePath, getStateFilePath } from "../../runtime/paths.js";
import { readCliCollabState } from "../../runtime/state-file.js";

export async function runCollabStatus(input: { workspaceRoot: string }) {
  const state = readCliCollabState(getStateFilePath(input.workspaceRoot));

  if (!state) {
    return { active: false as const, message: "No active collab." };
  }

  let broker;
  try {
    broker = createBrokerRuntime({
      sqlitePath: getBrokerSqlitePath(input.workspaceRoot),
      host: state.broker.host,
      port: state.broker.port,
    });
  } catch {
    return { active: false as const, message: "Broker database is unavailable." };
  }

  const threads = broker.control.listThreads(state.collabId);
  const activeThread = threads.find((t) => t.active) ?? null;
  const brokerHealth = broker.getHealth();

  await broker.stop();

  return {
    active: true as const,
    collabId: state.collabId,
    workspaceRoot: state.workspaceRoot,
    codexSessionId: state.sessions.codex.sessionId,
    claudeSessionId: state.sessions.claude.sessionId,
    brokerPath: state.broker.sqlitePath,
    brokerHealth,
    activeThread: activeThread
      ? { threadId: activeThread.threadId, title: activeThread.title }
      : null,
  };
}
