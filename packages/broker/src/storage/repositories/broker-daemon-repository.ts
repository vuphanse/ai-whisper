import type Database from "better-sqlite3";

export type BrokerDaemonRecord = {
	collabId: string;
	host: string;
	port: number;
	pid: number | null;
	pidStartTime: string | null;
	startedAt: string;
	lastHeartbeatAt: string;
};

type Row = {
	collab_id: string;
	host: string;
	port: number;
	pid: number | null;
	pid_start_time: string | null;
	started_at: string;
	last_heartbeat_at: string;
};

function toRecord(row: Row): BrokerDaemonRecord {
	return {
		collabId: row.collab_id,
		host: row.host,
		port: row.port,
		pid: row.pid,
		pidStartTime: row.pid_start_time,
		startedAt: row.started_at,
		lastHeartbeatAt: row.last_heartbeat_at,
	};
}

export function insertBrokerDaemon(
	db: Database.Database,
	input: {
		collabId: string;
		host: string;
		port: number;
		startedAt: string;
		lastHeartbeatAt: string;
	},
): void {
	db.prepare(`
		INSERT INTO broker_daemon
			(collab_id, host, port, pid, pid_start_time, started_at, last_heartbeat_at)
		VALUES (?, ?, ?, NULL, NULL, ?, ?)
	`).run(input.collabId, input.host, input.port, input.startedAt, input.lastHeartbeatAt);
}

export function updateBrokerDaemonPid(
	db: Database.Database,
	input: { collabId: string; pid: number; pidStartTime: string | null; now: string },
): void {
	db.prepare(`
		UPDATE broker_daemon
		SET pid = ?, pid_start_time = ?, last_heartbeat_at = ?
		WHERE collab_id = ?
	`).run(input.pid, input.pidStartTime, input.now, input.collabId);
}

export function updateBrokerDaemonHeartbeat(
	db: Database.Database,
	input: { collabId: string; now: string },
): void {
	db.prepare("UPDATE broker_daemon SET last_heartbeat_at = ? WHERE collab_id = ?").run(
		input.now,
		input.collabId,
	);
}

export function getBrokerDaemonByCollab(
	db: Database.Database,
	collabId: string,
): BrokerDaemonRecord | null {
	const row = db
		.prepare(
			"SELECT collab_id, host, port, pid, pid_start_time, started_at, last_heartbeat_at FROM broker_daemon WHERE collab_id = ?",
		)
		.get(collabId) as Row | undefined;
	return row ? toRecord(row) : null;
}

export function getBrokerDaemonByPort(
	db: Database.Database,
	port: number,
): BrokerDaemonRecord | null {
	const row = db
		.prepare(
			"SELECT collab_id, host, port, pid, pid_start_time, started_at, last_heartbeat_at FROM broker_daemon WHERE port = ?",
		)
		.get(port) as Row | undefined;
	return row ? toRecord(row) : null;
}

export function deleteBrokerDaemonByCollab(
	db: Database.Database,
	collabId: string,
): number {
	return db.prepare("DELETE FROM broker_daemon WHERE collab_id = ?").run(collabId).changes;
}

export function listStaleBrokerDaemons(
	db: Database.Database,
	cutoffIso: string,
): BrokerDaemonRecord[] {
	const rows = db
		.prepare(
			"SELECT collab_id, host, port, pid, pid_start_time, started_at, last_heartbeat_at FROM broker_daemon WHERE last_heartbeat_at < ?",
		)
		.all(cutoffIso) as Row[];
	return rows.map(toRecord);
}

export function listAllBrokerDaemons(db: Database.Database): BrokerDaemonRecord[] {
	const rows = db
		.prepare(
			"SELECT collab_id, host, port, pid, pid_start_time, started_at, last_heartbeat_at FROM broker_daemon",
		)
		.all() as Row[];
	return rows.map(toRecord);
}
