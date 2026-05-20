import { openDatabase } from "@ai-whisper/broker";
import { assessBrokerDaemon } from "./broker-daemon.js";
import { getSharedSqlitePath } from "./state-root.js";

export interface WaitForBrokerReadyInput {
	host: string;
	port: number;
	collabId: string;
	timeoutMs: number;
}

/**
 * Polls for the broker daemon to be up and healthy after a collab is
 * created. Extracted from create-cli.ts (`collab start`) so `collab mount`
 * can reuse it in its auto-create branch.
 */
export async function waitForBrokerReady(
	input: WaitForBrokerReadyInput,
): Promise<boolean> {
	const start = Date.now();
	const delayMs = 100;
	while (Date.now() - start < input.timeoutMs) {
		const db = openDatabase(getSharedSqlitePath());
		const row = db
			.prepare("SELECT pid FROM broker_daemon WHERE collab_id = ?")
			.get(input.collabId) as { pid: number | null } | undefined;
		db.close();
		const pid = row?.pid ?? 0;
		if (pid > 0) {
			const health = await assessBrokerDaemon({
				host: input.host,
				port: input.port,
				pid,
			});
			if (health.ok) return true;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
	}
	return false;
}
