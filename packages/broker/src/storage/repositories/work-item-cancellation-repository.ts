import type Database from "better-sqlite3";

export function insertWorkItemCancellation(
	db: Database.Database,
	input: { workItemId: string; requestedAt: string },
): void {
	db.prepare(
		`INSERT INTO work_item_cancellation (work_item_id, requested_at)
		 VALUES (?, ?)
		 ON CONFLICT(work_item_id) DO NOTHING`,
	).run(input.workItemId, input.requestedAt);
}

export function getWorkItemCancellationRequestedAt(
	db: Database.Database,
	workItemId: string,
): string | null {
	const row = db
		.prepare(
			`SELECT requested_at
			 FROM work_item_cancellation
			 WHERE work_item_id = ?`,
		)
		.get(workItemId) as { requested_at: string } | undefined;

	return row?.requested_at ?? null;
}
