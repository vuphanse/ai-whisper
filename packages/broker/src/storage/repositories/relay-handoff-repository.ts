import type Database from "better-sqlite3";
import { upsertRelayTurnState } from "./relay-turn-state-repository.js";
import { getCollab } from "./collab-repository.js";

export type RelayHandoffRecord = {
	handoffId: string;
	collabId: string;
	senderAgent: "codex" | "claude";
	targetAgent: "codex" | "claude";
	requestText: string;
	status: "pending" | "deferred" | "accepted" | "declined" | "handed_back" | "failed";
	captureStatus: "ok" | "no_response_captured_confidently" | "no_response_captured" | null;
	chainId: string | null;
	parentHandoffId: string | null;
	roundNumber: number | null;
	maxRounds: number;
	rootRequestText: string | null;
	handbackText: string | null;
	orchestratorStatus: "idle" | "pending" | "processed" | null;
	orchestratorVerdict: "done" | "loop" | "escalate" | null;
	orchestratorReason: string | null;
	orchestratorClaimedAt: string | null;
	orchestratorEvaluatedAt: string | null;
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
	capture_status: string | null;
	chain_id: string | null;
	parent_handoff_id: string | null;
	round_number: number | null;
	max_rounds: number;
	root_request_text: string | null;
	handback_text: string | null;
	orchestrator_status: string | null;
	orchestrator_verdict: string | null;
	orchestrator_reason: string | null;
	orchestrator_claimed_at: string | null;
	orchestrator_evaluated_at: string | null;
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
		captureStatus: row.capture_status as RelayHandoffRecord["captureStatus"],
		chainId: row.chain_id,
		parentHandoffId: row.parent_handoff_id,
		roundNumber: row.round_number,
		maxRounds: row.max_rounds,
		rootRequestText: row.root_request_text,
		handbackText: row.handback_text,
		orchestratorStatus: row.orchestrator_status as RelayHandoffRecord["orchestratorStatus"],
		orchestratorVerdict: row.orchestrator_verdict as RelayHandoffRecord["orchestratorVerdict"],
		orchestratorReason: row.orchestrator_reason,
		orchestratorClaimedAt: row.orchestrator_claimed_at,
		orchestratorEvaluatedAt: row.orchestrator_evaluated_at,
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
			`SELECT h.handoff_id, h.collab_id, h.sender_agent, h.target_agent, h.request_text, h.status,
			        h.capture_status, h.chain_id, h.parent_handoff_id, h.round_number, h.root_request_text,
			        h.handback_text, h.orchestrator_status, h.orchestrator_verdict, h.orchestrator_reason,
			        h.orchestrator_claimed_at, h.orchestrator_evaluated_at, h.created_at, h.accepted_at,
			        h.deferred_at, h.resolved_at, h.last_activity_at,
			        c.orchestrator_max_rounds AS max_rounds
			 FROM relay_handoff h
			 JOIN collab c ON c.collab_id = h.collab_id
			 WHERE h.handoff_id = ?`,
		)
		.get(handoffId) as
		| {
				handoff_id: string;
				collab_id: string;
				sender_agent: string;
				target_agent: string;
				request_text: string;
				status: string;
				capture_status: string | null;
				chain_id: string | null;
				parent_handoff_id: string | null;
				round_number: number | null;
				max_rounds: number;
				root_request_text: string | null;
				handback_text: string | null;
				orchestrator_status: string | null;
				orchestrator_verdict: string | null;
				orchestrator_reason: string | null;
				orchestrator_claimed_at: string | null;
				orchestrator_evaluated_at: string | null;
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
					"SELECT unresolved_handoff_id FROM relay_turn_state WHERE collab_id = ?",
				)
			.get(input.collabId) as { unresolved_handoff_id: string | null } | undefined;

		if (existing?.unresolved_handoff_id) {
			throw new Error(
				`Cannot create handoff: there is already an unresolved handoff (${existing.unresolved_handoff_id}) for collab ${input.collabId}`,
			);
		}

		// Read collab config to determine if orchestrator is enabled
		const collab = getCollab(db, input.collabId);
		const orchestratorEnabled = collab?.orchestratorEnabled ?? false;

		// Insert the handoff record, populating chain metadata when orchestrator is enabled
		db.prepare(
			`INSERT INTO relay_handoff
			   (handoff_id, collab_id, sender_agent, target_agent, request_text,
			    status, created_at, accepted_at, deferred_at, resolved_at, last_activity_at, capture_status,
			    chain_id, parent_handoff_id, round_number, root_request_text,
			    handback_text, orchestrator_status)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, NULL,
			         ?, NULL, ?, ?,
			         NULL, ?)`,
		).run(
			input.handoffId,
			input.collabId,
			input.senderAgent,
			input.targetAgent,
			input.requestText,
			input.now,
			input.now,
			orchestratorEnabled ? input.handoffId : null,
			orchestratorEnabled ? 1 : null,
			orchestratorEnabled ? input.requestText : null,
			orchestratorEnabled ? "idle" : null,
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
		captureStatus?: "ok" | "no_response_captured_confidently" | "no_response_captured" | null;
		now: string;
	},
): RelayHandoffRecord {
	return db.transaction(() => {
		const current = queryRelayHandoff(db, input.handoffId);
		if (!current) {
			throw new Error(`Unknown handoff: ${input.handoffId}`);
		}

		// Mark current as handed_back, store captureStatus on the completed record
		db.prepare(
			`UPDATE relay_handoff
			    SET status = 'handed_back', resolved_at = ?, last_activity_at = ?, capture_status = ?
			  WHERE handoff_id = ?`,
		).run(input.now, input.now, input.captureStatus ?? null, input.handoffId);

		// New pending handoff has no captureStatus yet
		db.prepare(
			`INSERT INTO relay_handoff
			   (handoff_id, collab_id, sender_agent, target_agent, request_text,
			    status, created_at, accepted_at, deferred_at, resolved_at, last_activity_at, capture_status)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, NULL, NULL, NULL, ?, NULL)`,
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

export function queryLatestHandedBackHandoff(
	db: Database.Database,
	collabId: string,
): RelayHandoffRecord | null {
	const row = db
		.prepare(
			`SELECT h.handoff_id, h.collab_id, h.sender_agent, h.target_agent, h.request_text, h.status,
			        h.capture_status, h.chain_id, h.parent_handoff_id, h.round_number, h.root_request_text,
			        h.handback_text, h.orchestrator_status, h.orchestrator_verdict, h.orchestrator_reason,
			        h.orchestrator_claimed_at, h.orchestrator_evaluated_at, h.created_at, h.accepted_at,
			        h.deferred_at, h.resolved_at, h.last_activity_at,
			        c.orchestrator_max_rounds AS max_rounds
			 FROM relay_handoff h
			 JOIN collab c ON c.collab_id = h.collab_id
			 WHERE h.collab_id = ? AND h.status = 'handed_back'
			 ORDER BY h.resolved_at DESC
			 LIMIT 1`,
		)
		.get(collabId) as
		| {
				handoff_id: string;
				collab_id: string;
				sender_agent: string;
				target_agent: string;
				request_text: string;
				status: string;
				capture_status: string | null;
				chain_id: string | null;
				parent_handoff_id: string | null;
				round_number: number | null;
				max_rounds: number;
				root_request_text: string | null;
				handback_text: string | null;
				orchestrator_status: string | null;
				orchestrator_verdict: string | null;
				orchestrator_reason: string | null;
				orchestrator_claimed_at: string | null;
				orchestrator_evaluated_at: string | null;
				created_at: string;
				accepted_at: string | null;
				deferred_at: string | null;
				resolved_at: string | null;
				last_activity_at: string;
		  }
		| undefined;
	return row ? rowToRecord(row) : null;
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
