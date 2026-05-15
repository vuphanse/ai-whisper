import os from "node:os";
import path from "node:path";

export function getStateRoot(): string {
	return process.env.AI_WHISPER_STATE_ROOT ?? path.join(os.homedir(), ".ai-whisper");
}

export function getSharedSqlitePath(): string {
	return path.join(getStateRoot(), "state.db");
}
