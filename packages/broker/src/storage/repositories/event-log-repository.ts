import type Database from "better-sqlite3";
import { eventEnvelopeSchema, type EventEnvelope } from "@ai-whisper/shared";

export function appendEvent(db: Database.Database, event: EventEnvelope): void {
	db.prepare(
		`INSERT INTO event_log (
      event_id,
      schema_version,
      event_type,
      collab_id,
      workspace_root,
      payload_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		event.eventId,
		event.version,
		event.eventType,
		event.collabId,
		event.workspaceRoot,
		JSON.stringify(event.payload),
		event.timestamp,
	);
}

export function listEventsForCollab(
	db: Database.Database,
	collabId: string,
): EventEnvelope[] {
	const rows = db
		.prepare(
			`SELECT event_id, schema_version, event_type, collab_id, workspace_root, payload_json, created_at
       FROM event_log
       WHERE collab_id = ?
       ORDER BY id ASC`,
		)
		.all(collabId) as Array<{
		event_id: string;
		schema_version: number;
		event_type: EventEnvelope["eventType"];
		collab_id: string;
		workspace_root: string;
		payload_json: string;
		created_at: string;
	}>;

	return rows.map((row) =>
		eventEnvelopeSchema.parse({
			version: row.schema_version,
			eventId: row.event_id,
			eventType: row.event_type,
			collabId: row.collab_id,
			workspaceRoot: row.workspace_root,
			timestamp: row.created_at,
			payload: JSON.parse(row.payload_json) as Record<string, unknown>,
		}),
	);
}
