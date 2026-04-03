import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type CliCollabState = {
  version: 1;
  collabId: string;
  workspaceRoot: string;
  broker: {
    sqlitePath: string;
    host: "127.0.0.1";
    port: number;
  };
  sessions: {
    codex: { sessionId: string; providerId: string; launchMode: "tmux" | "terminals" };
    claude: { sessionId: string; providerId: string; launchMode: "tmux" | "terminals" };
  };
  startedAt: string;
};

export function writeCliCollabState(path: string, state: CliCollabState): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(state, null, 2));
}

export function readCliCollabState(path: string): CliCollabState | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as CliCollabState;
  } catch {
    return null;
  }
}

export function clearCliCollabState(path: string): void {
  rmSync(path, { force: true });
}
