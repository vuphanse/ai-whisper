import type Database from "better-sqlite3";

export function insertRelayMonitor(
	db: Database.Database,
	input: { collabId: string; monitorId: string; now: string },
): void {
	db.prepare(
		`INSERT OR REPLACE INTO relay_monitor (collab_id, monitor_id, registered_at, last_heartbeat_at)
		 VALUES (?, ?, ?, ?)`,
	).run(input.collabId, input.monitorId, input.now, input.now);
}

export function updateRelayMonitorHeartbeat(
	db: Database.Database,
	input: { collabId: string; monitorId: string; now: string },
): void {
	db.prepare(
		`UPDATE relay_monitor SET last_heartbeat_at = ? WHERE collab_id = ? AND monitor_id = ?`,
	).run(input.now, input.collabId, input.monitorId);
}

const HEARTBEAT_TIMEOUT_MS = 60_000;

export function isRelayMonitorConnected(
	db: Database.Database,
	collabId: string,
	now?: string,
): boolean {
	if (now === undefined) {
		// No reference time — check existence only (monitor is connected if any row exists)
		const row = db
			.prepare(`SELECT 1 FROM relay_monitor WHERE collab_id = ? LIMIT 1`)
			.get(collabId) as { 1: number } | undefined;
		return row !== undefined;
	}

	const cutoff = new Date(Date.parse(now) - HEARTBEAT_TIMEOUT_MS).toISOString();

	const row = db
		.prepare(
			`SELECT 1 FROM relay_monitor WHERE collab_id = ? AND last_heartbeat_at > ? LIMIT 1`,
		)
		.get(collabId, cutoff) as { 1: number } | undefined;

	return row !== undefined;
}
