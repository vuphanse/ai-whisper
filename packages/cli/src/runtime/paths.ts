import os from "node:os";
import { join } from "node:path";

export function getRuntimeRoot(workspaceRoot: string): string {
	return join(workspaceRoot, ".ai-whisper", "runtime");
}

export function getLiveSessionBrokerTempRoot(): string {
	const username = process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
	return join(os.tmpdir(), "ai-whisper", username, "live-session-broker");
}

export function getStateFilePath(workspaceRoot: string): string {
	return join(getRuntimeRoot(workspaceRoot), "current-collab.json");
}

export function getBrokerSqlitePath(workspaceRoot: string): string {
	return join(getRuntimeRoot(workspaceRoot), "broker.sqlite");
}
