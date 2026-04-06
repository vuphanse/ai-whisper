import type Database from "better-sqlite3";
import {
	contextPacketSchema,
	workItemSchema,
	type WorkItem,
} from "@ai-whisper/shared";

export function insertWorkItem(
	db: Database.Database,
	workItem: WorkItem,
): void {
	db.prepare(
		`INSERT INTO work_item (
      work_item_id,
      thread_id,
      collab_id,
      turn_index,
      sender_session_id,
      target_session_id,
      requested_action,
      instruction,
      context_packet_json,
      delivery_state,
      artifact_manifest_ids_json,
      created_at,
      delivered_at,
      completed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		workItem.workItemId,
		workItem.threadId,
		workItem.collabId,
		workItem.turnIndex,
		workItem.senderSessionId,
		workItem.targetSessionId,
		workItem.requestedAction,
		workItem.instruction,
		JSON.stringify(workItem.contextPacket),
		workItem.deliveryState,
		JSON.stringify(workItem.artifactManifestIds),
		workItem.createdAt,
		workItem.deliveredAt,
		workItem.completedAt,
	);
}

export function getWorkItem(
	db: Database.Database,
	workItemId: string,
): WorkItem | null {
	const row = db
		.prepare(
			`SELECT work_item_id, thread_id, collab_id, turn_index, sender_session_id, target_session_id, requested_action, instruction, context_packet_json, delivery_state, artifact_manifest_ids_json, created_at, delivered_at, completed_at
       FROM work_item
       WHERE work_item_id = ?`,
		)
		.get(workItemId) as
		| {
				work_item_id: string;
				thread_id: string;
				collab_id: string;
				turn_index: number;
				sender_session_id: string;
				target_session_id: string;
				requested_action: string;
				instruction: string;
				context_packet_json: string;
				delivery_state: string;
				artifact_manifest_ids_json: string;
				created_at: string;
				delivered_at: string | null;
				completed_at: string | null;
		  }
		| undefined;

	if (!row) {
		return null;
	}

	return workItemSchema.parse({
		version: 1,
		workItemId: row.work_item_id,
		threadId: row.thread_id,
		collabId: row.collab_id,
		turnIndex: row.turn_index,
		senderSessionId: row.sender_session_id,
		targetSessionId: row.target_session_id,
		requestedAction: row.requested_action,
		instruction: row.instruction,
		contextPacket: contextPacketSchema.parse(
			JSON.parse(row.context_packet_json),
		),
		deliveryState: row.delivery_state,
		artifactManifestIds: JSON.parse(row.artifact_manifest_ids_json) as string[],
		createdAt: row.created_at,
		deliveredAt: row.delivered_at,
		completedAt: row.completed_at,
	});
}

export function listWorkItemsForThread(
	db: Database.Database,
	threadId: string,
): WorkItem[] {
	const rows = db
		.prepare(
			`SELECT work_item_id, thread_id, collab_id, turn_index, sender_session_id, target_session_id, requested_action, instruction, context_packet_json, delivery_state, artifact_manifest_ids_json, created_at, delivered_at, completed_at
       FROM work_item
       WHERE thread_id = ?
       ORDER BY turn_index ASC`,
		)
		.all(threadId) as Array<{
		work_item_id: string;
		thread_id: string;
		collab_id: string;
		turn_index: number;
		sender_session_id: string;
		target_session_id: string;
		requested_action: string;
		instruction: string;
		context_packet_json: string;
		delivery_state: string;
		artifact_manifest_ids_json: string;
		created_at: string;
		delivered_at: string | null;
		completed_at: string | null;
	}>;

	return rows.map((row) =>
		workItemSchema.parse({
			version: 1,
			workItemId: row.work_item_id,
			threadId: row.thread_id,
			collabId: row.collab_id,
			turnIndex: row.turn_index,
			senderSessionId: row.sender_session_id,
			targetSessionId: row.target_session_id,
			requestedAction: row.requested_action,
			instruction: row.instruction,
			contextPacket: contextPacketSchema.parse(
				JSON.parse(row.context_packet_json),
			),
			deliveryState: row.delivery_state,
			artifactManifestIds: JSON.parse(
				row.artifact_manifest_ids_json,
			) as string[],
			createdAt: row.created_at,
			deliveredAt: row.delivered_at,
			completedAt: row.completed_at,
		}),
	);
}

export function markWorkItemDelivered(
	db: Database.Database,
	workItemId: string,
	deliveredAt: string,
): void {
	db.prepare(
		"UPDATE work_item SET delivery_state = 'delivered', delivered_at = ? WHERE work_item_id = ? AND delivery_state = 'queued'",
	).run(deliveredAt, workItemId);
}

export function markWorkItemCompleted(
	db: Database.Database,
	workItemId: string,
	completedAt: string,
): void {
	db.prepare(
		"UPDATE work_item SET delivery_state = 'completed', completed_at = ? WHERE work_item_id = ?",
	).run(completedAt, workItemId);
}

export function markWorkItemsRecoveryBlockedForCollab(
	db: Database.Database,
	collabId: string,
	completedAt: string,
): void {
	db.prepare(
		`UPDATE work_item
		 SET delivery_state = 'recovery_blocked', completed_at = COALESCE(completed_at, ?)
		 WHERE collab_id = ? AND delivery_state IN ('queued', 'delivered')`,
	).run(completedAt, collabId);
}

export function markWorkItemFailed(
	db: Database.Database,
	workItemId: string,
	completedAt: string,
): void {
	db.prepare(
		"UPDATE work_item SET delivery_state = 'failed', completed_at = ? WHERE work_item_id = ?",
	).run(completedAt, workItemId);
}
