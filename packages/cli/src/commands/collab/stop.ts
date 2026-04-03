import { getStateFilePath } from "../../runtime/paths.js";
import { clearCliCollabState, readCliCollabState } from "../../runtime/state-file.js";

export function runCollabStop(input: { workspaceRoot: string }) {
  const statePath = getStateFilePath(input.workspaceRoot);
  const state = readCliCollabState(statePath);

  if (!state) {
    return { stopped: false as const, message: "No active collab." };
  }

  clearCliCollabState(statePath);
  return { stopped: true as const, collabId: state.collabId };
}
