import { getStateFilePath } from "../../runtime/paths.js";
import { readCliCollabState } from "../../runtime/state-file.js";

export function runCollabStatus(input: { workspaceRoot: string }) {
  const state = readCliCollabState(getStateFilePath(input.workspaceRoot));

  if (!state) {
    return { active: false as const, message: "No active collab." };
  }

  return {
    active: true as const,
    collabId: state.collabId,
    workspaceRoot: state.workspaceRoot,
    codexSessionId: state.sessions.codex.sessionId,
    claudeSessionId: state.sessions.claude.sessionId,
    brokerPath: state.broker.sqlitePath,
  };
}
