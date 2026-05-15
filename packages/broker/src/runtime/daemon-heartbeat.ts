import type Database from "better-sqlite3";
import { updateBrokerDaemonHeartbeat } from "../storage/repositories/broker-daemon-repository.js";

export interface DaemonHeartbeat {
	start(): void;
	stop(): void;
}

export function createDaemonHeartbeat(input: {
	db: Database.Database;
	collabId: string;
	intervalMs: number;
	now: () => string;
}): DaemonHeartbeat {
	let timer: NodeJS.Timeout | null = null;
	return {
		start() {
			if (timer) return;
			timer = setInterval(() => {
				try {
					updateBrokerDaemonHeartbeat(input.db, {
						collabId: input.collabId,
						now: input.now(),
					});
				} catch {
					// non-fatal; sweep will reclaim if persistent
				}
			}, input.intervalMs);
			timer.unref();
		},
		stop() {
			if (timer) {
				clearInterval(timer);
				timer = null;
			}
		},
	};
}
