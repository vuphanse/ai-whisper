import type Database from "better-sqlite3";

export type RecoveryStateValue = "normal" | "recovery_required" | "recovered";

export type RecoveryStateRecord = {
	collabId: string;
	state: RecoveryStateValue;
	idleAfterRecovery: boolean;
	recoveredAt: string | null;
};

type Row = {
	collab_id: string;
	state: RecoveryStateValue;
	idle_after_recovery: number;
	recovered_at: string | null;
};

function toRecord(row: Row): RecoveryStateRecord {
	return {
		collabId: row.collab_id,
		state: row.state,
		idleAfterRecovery: row.idle_after_recovery === 1,
		recoveredAt: row.recovered_at,
	};
}

export function upsertRecoveryState(
	db: Database.Database,
	input: RecoveryStateRecord,
): void {
	db.prepare(`
		INSERT INTO recovery_state (collab_id, state, idle_after_recovery, recovered_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(collab_id) DO UPDATE SET
			state = excluded.state,
			idle_after_recovery = excluded.idle_after_recovery,
			recovered_at = excluded.recovered_at
	`).run(input.collabId, input.state, input.idleAfterRecovery ? 1 : 0, input.recoveredAt);
}

export function getRecoveryState(
	db: Database.Database,
	collabId: string,
): RecoveryStateRecord | null {
	const row = db
		.prepare("SELECT collab_id, state, idle_after_recovery, recovered_at FROM recovery_state WHERE collab_id = ?")
		.get(collabId) as Row | undefined;
	return row ? toRecord(row) : null;
}

export function deleteRecoveryState(db: Database.Database, collabId: string): number {
	return db.prepare("DELETE FROM recovery_state WHERE collab_id = ?").run(collabId).changes as number;
}
