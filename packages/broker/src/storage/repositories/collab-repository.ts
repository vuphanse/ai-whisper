import type Database from "better-sqlite3";
import { collabSchema, type Collab } from "@ai-whisper/shared";

export function insertCollab(db: Database.Database, collab: Collab): void {
	db.prepare(
		`INSERT INTO collab (
      collab_id,
      workspace_root,
      display_name,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
	).run(
		collab.collabId,
		collab.workspaceRoot,
		collab.displayName,
		collab.status,
		collab.createdAt,
		collab.updatedAt,
	);
}

export function getCollab(
	db: Database.Database,
	collabId: string,
): Collab | null {
	const row = db
		.prepare(
			`SELECT collab_id, workspace_root, display_name, status, created_at, updated_at
       FROM collab
       WHERE collab_id = ?`,
		)
		.get(collabId) as
		| {
				collab_id: string;
				workspace_root: string;
				display_name: string;
				status: "active" | "stopped";
				created_at: string;
				updated_at: string;
		  }
		| undefined;

	if (!row) {
		return null;
	}

	return collabSchema.parse({
		version: 1,
		collabId: row.collab_id,
		workspaceRoot: row.workspace_root,
		displayName: row.display_name,
		status: row.status,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}
