import type Database from "better-sqlite3";

export type WorkspaceRecord = {
	id: string;
	workspaceRoot: string;
	firstSeenAt: string;
	lastSeenAt: string;
};

type Row = {
	id: string;
	workspace_root: string;
	first_seen_at: string;
	last_seen_at: string;
};

function toRecord(row: Row): WorkspaceRecord {
	return {
		id: row.id,
		workspaceRoot: row.workspace_root,
		firstSeenAt: row.first_seen_at,
		lastSeenAt: row.last_seen_at,
	};
}

export function upsertWorkspace(
	db: Database.Database,
	input: { id: string; workspaceRoot: string; now: string },
): void {
	db.prepare(`
		INSERT INTO workspace (id, workspace_root, first_seen_at, last_seen_at)
		VALUES (?, ?, ?, ?)
		ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at
	`).run(input.id, input.workspaceRoot, input.now, input.now);
}

export function getWorkspaceById(db: Database.Database, id: string): WorkspaceRecord | null {
	const row = db.prepare("SELECT * FROM workspace WHERE id = ?").get(id) as Row | undefined;
	return row ? toRecord(row) : null;
}

export function getWorkspaceByRoot(db: Database.Database, root: string): WorkspaceRecord | null {
	const row = db.prepare("SELECT * FROM workspace WHERE workspace_root = ?").get(root) as Row | undefined;
	return row ? toRecord(row) : null;
}

export function listWorkspaces(db: Database.Database): WorkspaceRecord[] {
	const rows = db.prepare("SELECT * FROM workspace ORDER BY last_seen_at DESC").all() as Row[];
	return rows.map(toRecord);
}
