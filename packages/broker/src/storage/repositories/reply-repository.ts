import type Database from "better-sqlite3";
import { replySchema, type Reply } from "@ai-whisper/shared";

export function insertReply(db: Database.Database, reply: Reply): void {
	db.prepare(
		`INSERT INTO reply (
      reply_id,
      thread_id,
      collab_id,
      work_item_id,
      source_session_id,
      turn_index,
      kind,
      content,
      transition_intent,
      artifact_manifest_ids_json,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		reply.replyId,
		reply.threadId,
		reply.collabId,
		reply.workItemId,
		reply.sourceSessionId,
		reply.turnIndex,
		reply.kind,
		reply.content,
		reply.transitionIntent,
		JSON.stringify(reply.artifactManifestIds),
		reply.createdAt,
	);
}

export function getReply(db: Database.Database, replyId: string): Reply | null {
	const row = db
		.prepare(
			`SELECT reply_id, thread_id, collab_id, work_item_id, source_session_id, turn_index, kind, content, transition_intent, artifact_manifest_ids_json, created_at
       FROM reply
       WHERE reply_id = ?`,
		)
		.get(replyId) as
		| {
				reply_id: string;
				thread_id: string;
				collab_id: string;
				work_item_id: string;
				source_session_id: string;
				turn_index: number;
				kind: string;
				content: string;
				transition_intent: string | null;
				artifact_manifest_ids_json: string;
				created_at: string;
		  }
		| undefined;

	if (!row) {
		return null;
	}

	return replySchema.parse({
		version: 1,
		replyId: row.reply_id,
		threadId: row.thread_id,
		collabId: row.collab_id,
		workItemId: row.work_item_id,
		sourceSessionId: row.source_session_id,
		turnIndex: row.turn_index,
		kind: row.kind,
		content: row.content,
		transitionIntent: row.transition_intent,
		artifactManifestIds: JSON.parse(row.artifact_manifest_ids_json) as string[],
		createdAt: row.created_at,
	});
}

export function listUnconsumedRepliesForSession(
	db: Database.Database,
	input: { collabId: string; threadId: string; forSessionId: string },
): Reply[] {
	const rows = db
		.prepare(
			`SELECT reply_id, thread_id, collab_id, work_item_id, source_session_id,
			        turn_index, kind, content, transition_intent,
			        artifact_manifest_ids_json, created_at
			 FROM reply
			 WHERE collab_id = ?
			   AND thread_id = ?
			   AND source_session_id != ?
			   AND NOT EXISTS (
			     SELECT 1 FROM json_each(consumed_by_json)
			     WHERE json_each.value = ?
			   )
			 ORDER BY created_at ASC
			 LIMIT 3`,
		)
		.all(
			input.collabId,
			input.threadId,
			input.forSessionId,
			input.forSessionId,
		) as Array<{
		reply_id: string;
		thread_id: string;
		collab_id: string;
		work_item_id: string;
		source_session_id: string;
		turn_index: number;
		kind: string;
		content: string;
		transition_intent: string | null;
		artifact_manifest_ids_json: string;
		created_at: string;
	}>;

	return rows.map((row) =>
		replySchema.parse({
			version: 1,
			replyId: row.reply_id,
			threadId: row.thread_id,
			collabId: row.collab_id,
			workItemId: row.work_item_id,
			sourceSessionId: row.source_session_id,
			turnIndex: row.turn_index,
			kind: row.kind,
			content: row.content,
			transitionIntent: row.transition_intent,
			artifactManifestIds: JSON.parse(row.artifact_manifest_ids_json) as string[],
			createdAt: row.created_at,
		}),
	);
}

export function markRepliesConsumed(
	db: Database.Database,
	input: { replyIds: string[]; consumedBySessionId: string },
): void {
	const stmt = db.prepare(
		`UPDATE reply
		 SET consumed_by_json = json_insert(consumed_by_json, '$[#]', ?)
		 WHERE reply_id = ?
		   AND NOT EXISTS (
		     SELECT 1 FROM json_each(consumed_by_json)
		     WHERE json_each.value = ?
		   )`,
	);
	for (const replyId of input.replyIds) {
		stmt.run(input.consumedBySessionId, replyId, input.consumedBySessionId);
	}
}

export function listRepliesForThread(
	db: Database.Database,
	threadId: string,
): Reply[] {
	const rows = db
		.prepare(
			`SELECT reply_id, thread_id, collab_id, work_item_id, source_session_id, turn_index, kind, content, transition_intent, artifact_manifest_ids_json, created_at
       FROM reply
       WHERE thread_id = ?
       ORDER BY created_at ASC`,
		)
		.all(threadId) as Array<{
		reply_id: string;
		thread_id: string;
		collab_id: string;
		work_item_id: string;
		source_session_id: string;
		turn_index: number;
		kind: string;
		content: string;
		transition_intent: string | null;
		artifact_manifest_ids_json: string;
		created_at: string;
	}>;

	return rows.map((row) =>
		replySchema.parse({
			version: 1,
			replyId: row.reply_id,
			threadId: row.thread_id,
			collabId: row.collab_id,
			workItemId: row.work_item_id,
			sourceSessionId: row.source_session_id,
			turnIndex: row.turn_index,
			kind: row.kind,
			content: row.content,
			transitionIntent: row.transition_intent,
			artifactManifestIds: JSON.parse(
				row.artifact_manifest_ids_json,
			) as string[],
			createdAt: row.created_at,
		}),
	);
}
