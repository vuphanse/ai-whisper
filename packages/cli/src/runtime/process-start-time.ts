import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import type Database from "better-sqlite3";
import { updateBrokerDaemonPid } from "@ai-whisper/broker";

export function readProcessStartTime(pid: number): string | null {
	if (process.platform === "linux") {
		try {
			const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 1).trim().split(/\s+/);
			return fields[19] ?? null;
		} catch {
			return null;
		}
	}
	if (process.platform === "darwin") {
		try {
			const out = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], {
				encoding: "utf8",
			});
			const trimmed = out.trim();
			return trimmed.length > 0 ? trimmed : null;
		} catch {
			return null;
		}
	}
	return null;
}

export function writeOwnPidToBrokerDaemon(
	db: Database.Database,
	input: { collabId: string; now: string },
): void {
	updateBrokerDaemonPid(db, {
		collabId: input.collabId,
		pid: process.pid,
		pidStartTime: readProcessStartTime(process.pid),
		now: input.now,
	});
}
