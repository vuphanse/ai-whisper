import type Database from "better-sqlite3";

export interface RelayEvent {
	id: number;
	collabId: string;
	eventType: "relay_directive" | "relay_response" | "status" | "cancellation";
	senderAgent: string | null;
	receiverAgent: string | null;
	content: string;
	createdAt: string;
}

export function appendRelayEvent(
	db: Database.Database,
	input: {
		collabId: string;
		eventType: string;
		senderAgent: string | null;
		receiverAgent: string | null;
		content: string;
		now: string;
	},
): void {
	db.prepare(
		`INSERT INTO relay_event (collab_id, event_type, sender_agent, receiver_agent, content, created_at)
		 VALUES (?, ?, ?, ?, ?, ?)`,
	).run(
		input.collabId,
		input.eventType,
		input.senderAgent,
		input.receiverAgent,
		input.content,
		input.now,
	);
}

export function pollRelayEvents(
	db: Database.Database,
	collabId: string,
	afterId: number,
): RelayEvent[] {
	const rows = db
		.prepare(
			`SELECT id, collab_id, event_type, sender_agent, receiver_agent, content, created_at
			 FROM relay_event
			 WHERE collab_id = ? AND id > ?
			 ORDER BY id ASC`,
		)
		.all(collabId, afterId) as Array<{
		id: number;
		collab_id: string;
		event_type: string;
		sender_agent: string | null;
		receiver_agent: string | null;
		content: string;
		created_at: string;
	}>;

	return rows.map((row) => ({
		id: row.id,
		collabId: row.collab_id,
		eventType: row.event_type as RelayEvent["eventType"],
		senderAgent: row.sender_agent,
		receiverAgent: row.receiver_agent,
		content: row.content,
		createdAt: row.created_at,
	}));
}
