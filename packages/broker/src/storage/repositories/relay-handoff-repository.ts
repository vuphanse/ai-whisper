import type Database from "better-sqlite3";
import { upsertRelayTurnState } from "./relay-turn-state-repository.js";

export type RelayHandoffRecord = {
	handoffId: string;
	collabId: string;
	senderAgent: "codex" | "claude";
	targetAgent: "codex" | "claude";
	requestText: string;
	status: "pending" | "deferred" | "accepted" | "declined" | "handed_back" | "failed";
	createdAt: string;
	acceptedAt: string | null;
	deferredAt: string | null;
	resolvedAt: string | null;
	lastActivityAt: string;
};

function rowToRecord(row: {
	handoff_id: string;
	collab_id: string;
	sender_agent: string;
	target_agent: string;
	request_text: string;
	status: string;
	created_at: string;
	accepted_at: string | null;
	deferred_at: string | null;
	resolved_at: string | null;
	last_activity_at: string;
}): RelayHandoffRecord {
	return {
		handoffId: row.handoff_id,
		collabId: row.collab_id,
		senderAgent: row.sender_agent as RelayHandoffRecord["senderAgent"],
		targetAgent: row.target_agent as RelayHandoffRecord["targetAgent"],
		requestText: row.request_text,
		status: row.status as RelayHandoffRecord["status"],
		createdAt: row.created_at,
		acceptedAt: row.accepted_at,
		deferredAt: row.deferred_at,
		resolvedAt: row.resolved_at,
		lastActivityAt: row.last_activity_at,
	};
}

export function queryRelayHandoff(
	db: Database.Database,
	handoffId: string,
): RelayHandoffRecord | null {
	const row = db
		.prepare(
			`SELECT handoff_id, collab_id, sender_agent, target_agent, request_text, status,
			        created_at, accepted_at, deferred_at, resolved_at, last_activity_at
			 FROM relay_handoff
			 WHERE handoff_id = ?`,
		)
		.get(handoffId) as
		| {
				handoff_id: string;
				collab_id: string;
				sender_agent: string;
				target_agent: string;
				request_text: string;
				status: string;
				created_at: string;
				accepted_at: string | null;
				deferred_at: string | null;
				resolved_at: string | null;
				last_activity_at: string;
		  }
		| undefined;

	return row ? rowToRecord(row) : null;
}

export function createRelayHandoffTxn(
	db: Database.Database,
	input: {
		handoffId: string;
		collabId: string;
		senderAgent: "codex" | "claude";
		targetAgent: "codex" | "claude";
		requestText: string;
		now: string;
	},
): RelayHandoffRecord {
	return db.transaction(() => {
		// Check for existing unresolved handoff
		const existing = db
			.prepare(
				`SELECT unresolved_handoff_id FROM relay_turn_state WHERE collab_id = ?`,
			)
			.get(input.collabId) as { unresolved_handoff_id: string | null } | undefined;

		if (existing?.unresolved_handoff_id) {
			throw new Error(
				`Cannot create handoff: there is already an unresolved handoff (${existing.unresolved_handoff_id}) for collab ${input.collabId}`,
			);
		}

		// Insert the handoff record
		db.prepare(
			`INSERT INTO relay_handoff (handoff_id, collab_id, sender_agent, target_agent, request_text, status, created_at, accepted_at, deferred_at, resolved_at, last_activity_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?)`,
		).run(
			input.handoffId,
			input.collabId,
			input.senderAgent,
			input.targetAgent,
			input.requestText,
			input.now,
			input.now,
		);

		// Flip turn ownership to the target agent and record the unresolved handoff
		upsertRelayTurnState(db, {
			collabId: input.collabId,
			turnOwner: input.targetAgent,
			waitingAgent: input.senderAgent,
			unresolvedHandoffId: input.handoffId,
			handoffState: "pending",
			updatedAt: input.now,
		});

		return queryRelayHandoff(db, input.handoffId) as RelayHandoffRecord;
	})();
}

export function acceptRelayHandoffTxn(
	db: Database.Database,
	input: { handoffId: string; acceptedAt: string },
): void {
	db.transaction(() => {
		db.prepare(
			`UPDATE relay_handoff SET status = 'accepted', accepted_at = ?, last_activity_at = ?
			 WHERE handoff_id = ?`,
		).run(input.acceptedAt, input.acceptedAt, input.handoffId);

		const handoff = queryRelayHandoff(db, input.handoffId);
		if (handoff) {
			db.prepare(
				`UPDATE relay_turn_state SET handoff_state = 'accepted', updated_at = ?
				 WHERE collab_id = ? AND unresolved_handoff_id = ?`,
			).run(input.acceptedAt, handoff.collabId, input.handoffId);
		}
	})();
}

export function deferRelayHandoffTxn(
	db: Database.Database,
	input: { handoffId: string; deferredAt: string },
): void {
	db.transaction(() => {
		db.prepare(
			`UPDATE relay_handoff SET status = 'deferred', deferred_at = ?, last_activity_at = ?
			 WHERE handoff_id = ?`,
		).run(input.deferredAt, input.deferredAt, input.handoffId);

		const handoff = queryRelayHandoff(db, input.handoffId);
		if (handoff) {
			db.prepare(
				`UPDATE relay_turn_state SET handoff_state = 'deferred', updated_at = ?
				 WHERE collab_id = ? AND unresolved_handoff_id = ?`,
			).run(input.deferredAt, handoff.collabId, input.handoffId);
		}
	})();
}

/**
 * Marks a handoff as stale at the workflow level by setting `handoff_state = 'stale_handoff'`
 * on `relay_turn_state`. The `relay_handoff` record itself is intentionally NOT given a
 * "stale" status — `"stale"` is not a terminal handoff status and does not appear in
 * `RelayHandoffRecord.status`. Staleness is a transient workflow annotation on turn state,
 * not a resolved outcome for the handoff record.
 *
 * Callers that need to determine whether a handoff is stale MUST read `getRelayTurnState`
 * (checking `handoffState === "stale_handoff"`) rather than inspecting the handoff record's
 * `status` field directly. Reading `getRelayHandoff(id).status` after this call will still
 * return the previous status (e.g. `"deferred"` or `"accepted"`), which is correct by design.
 */
export function markRelayHandoffStaleTxn(
	db: Database.Database,
	input: { handoffId: string; now: string },
): void {
	db.transaction(() => {
		db.prepare(
			`UPDATE relay_handoff SET last_activity_at = ?
			 WHERE handoff_id = ?`,
		).run(input.now, input.handoffId);

		const handoff = queryRelayHandoff(db, input.handoffId);
		if (handoff) {
			db.prepare(
				`UPDATE relay_turn_state SET handoff_state = 'stale_handoff', updated_at = ?
				 WHERE collab_id = ? AND unresolved_handoff_id = ?`,
			).run(input.now, handoff.collabId, input.handoffId);
		}
	})();
}

export function declineRelayHandoffTxn(
	db: Database.Database,
	input: { handoffId: string; now: string },
): void {
	db.transaction(() => {
		const handoff = queryRelayHandoff(db, input.handoffId);

		db.prepare(
			`UPDATE relay_handoff SET status = 'declined', resolved_at = ?, last_activity_at = ?
			 WHERE handoff_id = ?`,
		).run(input.now, input.now, input.handoffId);

		if (handoff) {
			// Reset turn state to idle
			upsertRelayTurnState(db, {
				collabId: handoff.collabId,
				turnOwner: "none",
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle",
				updatedAt: input.now,
			});
		}
	})();
}

export function handoffBackRelayTxn(
	db: Database.Database,
	input: {
		handoffId: string;
		nextHandoffId: string;
		senderAgent: "codex" | "claude";
		targetAgent: "codex" | "claude";
		requestText: string;
		now: string;
	},
): RelayHandoffRecord {
	return db.transaction(() => {
		const current = queryRelayHandoff(db, input.handoffId);
		if (!current) {
			throw new Error(`Unknown handoff: ${input.handoffId}`);
		}

		// Mark the current handoff as handed_back
		db.prepare(
			`UPDATE relay_handoff SET status = 'handed_back', resolved_at = ?, last_activity_at = ?
			 WHERE handoff_id = ?`,
		).run(input.now, input.now, input.handoffId);

		// Insert the new pending handoff
		db.prepare(
			`INSERT INTO relay_handoff (handoff_id, collab_id, sender_agent, target_agent, request_text, status, created_at, accepted_at, deferred_at, resolved_at, last_activity_at)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?)`,
		).run(
			input.nextHandoffId,
			current.collabId,
			input.senderAgent,
			input.targetAgent,
			input.requestText,
			input.now,
			input.now,
		);

		// Atomically flip turn ownership to the new target and point to the new handoff
		upsertRelayTurnState(db, {
			collabId: current.collabId,
			turnOwner: input.targetAgent,
			waitingAgent: input.senderAgent,
			unresolvedHandoffId: input.nextHandoffId,
			handoffState: "pending",
			updatedAt: input.now,
		});

		return queryRelayHandoff(db, input.nextHandoffId) as RelayHandoffRecord;
	})();
}

export function failRelayHandoffOnDisconnectTxn(
	db: Database.Database,
	input: { handoffId: string; now: string },
): void {
	db.transaction(() => {
		const handoff = queryRelayHandoff(db, input.handoffId);

		db.prepare(
			`UPDATE relay_handoff SET status = 'failed', resolved_at = ?, last_activity_at = ?
			 WHERE handoff_id = ?`,
		).run(input.now, input.now, input.handoffId);

		if (handoff) {
			// Reset turn state to idle
			upsertRelayTurnState(db, {
				collabId: handoff.collabId,
				turnOwner: "none",
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle",
				updatedAt: input.now,
			});
		}
	})();
}
