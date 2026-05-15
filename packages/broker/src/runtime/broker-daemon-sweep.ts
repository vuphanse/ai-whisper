import type Database from "better-sqlite3";
import {
	deleteBrokerDaemonByCollab,
	listStaleBrokerDaemons,
} from "../storage/repositories/broker-daemon-repository.js";

export type IsAliveResult = { alive: boolean; startTime: string | null };

export async function sweepStaleBrokerDaemons(input: {
	db: Database.Database;
	cutoffIso: string;
	isAlive: (pid: number) => Promise<IsAliveResult>;
}): Promise<{ deleted: number }> {
	const stale = listStaleBrokerDaemons(input.db, input.cutoffIso);
	let deleted = 0;
	for (const row of stale) {
		if (row.pid === null) {
			deleteBrokerDaemonByCollab(input.db, row.collabId);
			deleted += 1;
			continue;
		}
		const { alive, startTime } = await input.isAlive(row.pid);
		if (!alive) {
			deleteBrokerDaemonByCollab(input.db, row.collabId);
			deleted += 1;
			continue;
		}
		if (
			row.pidStartTime !== null &&
			startTime !== null &&
			startTime !== row.pidStartTime
		) {
			deleteBrokerDaemonByCollab(input.db, row.collabId);
			deleted += 1;
			continue;
		}
		// alive + start_time matches (or both unknown): heartbeat stalled. Leave row.
	}
	return { deleted };
}

export function defaultIsAlive(pid: number): Promise<IsAliveResult> {
	try {
		process.kill(pid, 0);
		return Promise.resolve({ alive: true, startTime: null });
	} catch (err: unknown) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code === "ESRCH") return Promise.resolve({ alive: false, startTime: null });
		if (code === "EPERM") return Promise.resolve({ alive: true, startTime: null });
		return Promise.resolve({ alive: false, startTime: null });
	}
}
