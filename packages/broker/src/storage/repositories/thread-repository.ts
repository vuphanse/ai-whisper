import type Database from "better-sqlite3";
import { threadSchema, type Thread } from "@ai-whisper/shared";

export function insertThread(db: Database.Database, thread: Thread): void {
	db.prepare(
		`INSERT INTO thread (
      thread_id,
      collab_id,
      title,
      thread_state,
      base_context_ref,
      current_turn_index,
      active,
      created_by_session_id,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		thread.threadId,
		thread.collabId,
		thread.title,
		thread.threadState,
		thread.baseContextRef,
		thread.currentTurnIndex,
		thread.active ? 1 : 0,
		thread.createdBySessionId,
		thread.createdAt,
		thread.updatedAt,
	);
}

export function getThread(
	db: Database.Database,
	threadId: string,
): Thread | null {
	const row = db
		.prepare(
			`SELECT thread_id, collab_id, title, thread_state, base_context_ref, current_turn_index, active, created_by_session_id, created_at, updated_at
       FROM thread
       WHERE thread_id = ?`,
		)
		.get(threadId) as
		| {
				thread_id: string;
				collab_id: string;
				title: string;
				thread_state: string;
				base_context_ref: string | null;
				current_turn_index: number;
				active: number;
				created_by_session_id: string;
				created_at: string;
				updated_at: string;
		  }
		| undefined;

	if (!row) {
		return null;
	}

	return threadSchema.parse({
		version: 1,
		threadId: row.thread_id,
		collabId: row.collab_id,
		title: row.title,
		threadState: row.thread_state,
		baseContextRef: row.base_context_ref,
		currentTurnIndex: row.current_turn_index,
		active: row.active === 1,
		createdBySessionId: row.created_by_session_id,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	});
}

export function listThreadsForCollab(
	db: Database.Database,
	collabId: string,
): Thread[] {
	const rows = db
		.prepare(
			`SELECT thread_id, collab_id, title, thread_state, base_context_ref, current_turn_index, active, created_by_session_id, created_at, updated_at
       FROM thread
       WHERE collab_id = ?
       ORDER BY created_at ASC`,
		)
		.all(collabId) as Array<{
		thread_id: string;
		collab_id: string;
		title: string;
		thread_state: string;
		base_context_ref: string | null;
		current_turn_index: number;
		active: number;
		created_by_session_id: string;
		created_at: string;
		updated_at: string;
	}>;

	return rows.map((row) =>
		threadSchema.parse({
			version: 1,
			threadId: row.thread_id,
			collabId: row.collab_id,
			title: row.title,
			threadState: row.thread_state,
			baseContextRef: row.base_context_ref,
			currentTurnIndex: row.current_turn_index,
			active: row.active === 1,
			createdBySessionId: row.created_by_session_id,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		}),
	);
}

export function markOnlyThreadActive(
	db: Database.Database,
	collabId: string,
	activeThreadId: string | null,
): void {
	db.prepare("UPDATE thread SET active = 0 WHERE collab_id = ?").run(collabId);
	if (activeThreadId) {
		db.prepare("UPDATE thread SET active = 1 WHERE thread_id = ?").run(
			activeThreadId,
		);
	}
}

export function updateThreadState(
	db: Database.Database,
	threadId: string,
	threadState: string,
	updatedAt: string,
): void {
	db.prepare(
		"UPDATE thread SET thread_state = ?, updated_at = ? WHERE thread_id = ?",
	).run(threadState, updatedAt, threadId);
}

export function updateThreadTurnIndex(
	db: Database.Database,
	threadId: string,
	nextTurnIndex: number,
	baseContextRef: string | null,
	updatedAt: string,
): void {
	db.prepare(
		"UPDATE thread SET current_turn_index = ?, base_context_ref = ?, updated_at = ? WHERE thread_id = ?",
	).run(nextTurnIndex, baseContextRef, updatedAt, threadId);
}
