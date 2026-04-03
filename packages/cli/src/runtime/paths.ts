import { join } from "node:path";

export function getRuntimeRoot(workspaceRoot: string): string {
	return join(workspaceRoot, ".ai-whisper", "runtime");
}

export function getStateFilePath(workspaceRoot: string): string {
	return join(getRuntimeRoot(workspaceRoot), "current-collab.json");
}

export function getBrokerSqlitePath(workspaceRoot: string): string {
	return join(getRuntimeRoot(workspaceRoot), "broker.sqlite");
}
