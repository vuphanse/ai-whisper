import os from "node:os";
import { join } from "node:path";

export function getLiveSessionBrokerTempRoot(): string {
	const username = process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
	return join(os.tmpdir(), "ai-whisper", username, "live-session-broker");
}
