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
			orchestratorEnabled,
			currentRound: orchestratorEnabled ? 1 : 0,
			maxRounds: collab?.orchestratorMaxRounds ?? 3,
			chainStatus: orchestratorEnabled ? "active" : "done",
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
			const collab = getCollab(db, handoff.collabId);
			upsertRelayTurnState(db, {
				collabId: handoff.collabId,
				turnOwner: "none",
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle",
				updatedAt: input.now,
				orchestratorEnabled: collab?.orchestratorEnabled ?? false,
				currentRound: 0,
				maxRounds: collab?.orchestratorMaxRounds ?? 3,
				chainStatus: "done",
			});
		}
	})();
}

export function handoffBackRelayTxn(
	db: Database.Database,
	input: {
		handoffId: string;
		nextHandoffId?: string;
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

		const collab = getCollab(db, current.collabId);
		const orchestratorEnabled = collab?.orchestratorEnabled ?? false;

		if (orchestratorEnabled) {
			// Orchestrated path: mark handed_back and set orchestrator_status = 'idle' so
			// the orchestrator can claim it. Do NOT create a next handoff here — the
			// orchestrator is responsible for creating the loop handoff after evaluating.
			db.prepare(
				`UPDATE relay_handoff
				    SET status = 'handed_back', resolved_at = ?, last_activity_at = ?,
				        capture_status = ?, handback_text = ?, orchestrator_status = 'idle'
				  WHERE handoff_id = ?`,
			).run(input.now, input.now, input.captureStatus ?? null, input.requestText, input.handoffId);

			// Return turn ownership to the sender — orchestrator decides next action
			upsertRelayTurnState(db, {
				collabId: current.collabId,
				turnOwner: current.senderAgent,
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle",
				updatedAt: input.now,
				orchestratorEnabled: true,
				currentRound: current.roundNumber ?? 1,
				maxRounds: collab?.orchestratorMaxRounds ?? current.maxRounds,
				chainStatus: "active",
			});

			return queryRelayHandoff(db, input.handoffId) as RelayHandoffRecord;
		}

		// Non-orchestrated path: create the next handoff immediately
		if (!input.nextHandoffId) {
			throw new Error("nextHandoffId is required for non-orchestrated handoffBackRelay");
		}

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

		upsertRelayTurnState(db, {
			collabId: current.collabId,
			turnOwner: input.targetAgent,
			waitingAgent: input.senderAgent,
			unresolvedHandoffId: input.nextHandoffId,
			handoffState: "pending",
			updatedAt: input.now,
			orchestratorEnabled: false,
			currentRound: 0,
			maxRounds: 3,
			chainStatus: "done",
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
			const collab = getCollab(db, handoff.collabId);
			upsertRelayTurnState(db, {
				collabId: handoff.collabId,
				turnOwner: "none",
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle",
				updatedAt: input.now,
				orchestratorEnabled: collab?.orchestratorEnabled ?? false,
				currentRound: 0,
				maxRounds: collab?.orchestratorMaxRounds ?? 3,
				chainStatus: "done",
			});
		}
	})();
}

export function claimRelayHandoffForOrchestrationTxn(
	db: Database.Database,
	input: { handoffId: string; claimedAt: string },
): RelayHandoffRecord | null {
	const result = db
		.prepare(
			`UPDATE relay_handoff
			    SET orchestrator_status = 'pending',
			        orchestrator_claimed_at = ?
			  WHERE handoff_id = ?
			    AND status = 'handed_back'
			    AND orchestrator_status = 'idle'`,
		)
		.run(input.claimedAt, input.handoffId);

	return result.changes === 1 ? queryRelayHandoff(db, input.handoffId) : null;
}

export function listRelayHandoffsPendingOrchestration(
	db: Database.Database,
	collabId: string,
): RelayHandoffRecord[] {
	const rows = db
		.prepare(
			`SELECT h.handoff_id, h.collab_id, h.sender_agent, h.target_agent, h.request_text, h.status,
			        h.capture_status, h.chain_id, h.parent_handoff_id, h.round_number, h.root_request_text,
			        h.handback_text, h.orchestrator_status, h.orchestrator_verdict, h.orchestrator_reason,
			        h.orchestrator_claimed_at, h.orchestrator_evaluated_at, h.created_at, h.accepted_at,
			        h.deferred_at, h.resolved_at, h.last_activity_at,
			        c.orchestrator_max_rounds AS max_rounds
			 FROM relay_handoff h
			 JOIN collab c ON c.collab_id = h.collab_id
			 WHERE h.collab_id = ?
			   AND h.status = 'handed_back'
			   AND h.orchestrator_status = 'idle'`,
		)
		.all(collabId) as Array<{
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
	}>;
	return rows.map(rowToRecord);
}

export function createLoopRelayHandoffTxn(
	db: Database.Database,
	input: {
		handoffId: string;
		nextHandoffId: string;
		requestText: string;
		reason: string;
		now: string;
	},
): RelayHandoffRecord {
	return db.transaction(() => {
		const current = queryRelayHandoff(db, input.handoffId);
		if (!current) throw new Error(`Unknown handoff: ${input.handoffId}`);

		const collab = getCollab(db, current.collabId);
		const maxRounds = collab?.orchestratorMaxRounds ?? current.maxRounds;

		// Insert next handoff with swapped agents
		db.prepare(
			`INSERT INTO relay_handoff
			   (handoff_id, collab_id, sender_agent, target_agent, request_text,
			    status, chain_id, parent_handoff_id, round_number, root_request_text,
			    handback_text, orchestrator_status, orchestrator_verdict, orchestrator_reason,
			    orchestrator_claimed_at, orchestrator_evaluated_at, created_at, accepted_at,
			    deferred_at, resolved_at, last_activity_at, capture_status)
			 VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, NULL, 'idle', NULL, NULL, NULL, NULL, ?, NULL, NULL, NULL, ?, NULL)`,
		).run(
			input.nextHandoffId,
			current.collabId,
			current.targetAgent, // SWAPPED: previous target becomes new sender
			current.senderAgent, // SWAPPED: previous sender becomes new target
			input.requestText,
			current.chainId,
			current.handoffId,
			(current.roundNumber ?? 1) + 1,
			current.rootRequestText,
			input.now,
			input.now,
		);

		// Finalize current handoff
		db.prepare(
			`UPDATE relay_handoff
			    SET orchestrator_status = 'processed',
			        orchestrator_verdict = 'loop',
			        orchestrator_reason = ?,
			        orchestrator_evaluated_at = ?
			  WHERE handoff_id = ?
			    AND orchestrator_status = 'pending'`,
		).run(input.reason, input.now, current.handoffId);

		// Update turn state
		upsertRelayTurnState(db, {
			collabId: current.collabId,
			turnOwner: current.senderAgent, // new target receives ownership
			waitingAgent: current.targetAgent, // new sender waits
			unresolvedHandoffId: input.nextHandoffId,
			handoffState: "pending",
			orchestratorEnabled: true,
			currentRound: (current.roundNumber ?? 1) + 1,
			maxRounds,
			chainStatus: "active",
			updatedAt: input.now,
		});

		return queryRelayHandoff(db, input.nextHandoffId)!;
	})();
}

export function resolveRelayChainTxn(
	db: Database.Database,
	input: { handoffId: string; reason: string; evaluatedAt: string },
): void {
	db.transaction(() => {
		const current = queryRelayHandoff(db, input.handoffId);
		if (!current) throw new Error(`Unknown handoff: ${input.handoffId}`);

		const collab = getCollab(db, current.collabId);
		const maxRounds = collab?.orchestratorMaxRounds ?? current.maxRounds;

		db.prepare(
			`UPDATE relay_handoff
			    SET orchestrator_status = 'processed',
			        orchestrator_verdict = 'done',
			        orchestrator_reason = ?,
			        orchestrator_evaluated_at = ?
			  WHERE handoff_id = ?`,
		).run(input.reason, input.evaluatedAt, input.handoffId);

		upsertRelayTurnState(db, {
			collabId: current.collabId,
			turnOwner: current.senderAgent,
			waitingAgent: null,
			unresolvedHandoffId: null,
			handoffState: "idle",
			orchestratorEnabled: true,
			currentRound: current.roundNumber ?? 1,
			maxRounds,
			chainStatus: "done",
			updatedAt: input.evaluatedAt,
		});
	})();
}

export function markRelayChainEscalatedTxn(
	db: Database.Database,
	input: { handoffId: string; reason: string; evaluatedAt: string },
): void {
	db.transaction(() => {
		const current = queryRelayHandoff(db, input.handoffId);
		if (!current) throw new Error(`Unknown handoff: ${input.handoffId}`);

		const collab = getCollab(db, current.collabId);
		const maxRounds = collab?.orchestratorMaxRounds ?? current.maxRounds;

		db.prepare(
			`UPDATE relay_handoff
			    SET orchestrator_status = 'processed',
			        orchestrator_verdict = 'escalate',
			        orchestrator_reason = ?,
			        orchestrator_evaluated_at = ?
			  WHERE handoff_id = ?`,
		).run(input.reason, input.evaluatedAt, input.handoffId);

		upsertRelayTurnState(db, {
			collabId: current.collabId,
			turnOwner: current.senderAgent,
			waitingAgent: null,
			unresolvedHandoffId: null,
			handoffState: "idle",
			orchestratorEnabled: true,
			currentRound: current.roundNumber ?? 1,
			maxRounds,
			chainStatus: "escalated",
			updatedAt: input.evaluatedAt,
		});
	})();
}

export function markRelayChainAbandonedTxn(
	db: Database.Database,
	input: { handoffId: string; reason: string; evaluatedAt: string },
): void {
	db.transaction(() => {
		const current = queryRelayHandoff(db, input.handoffId);
		if (!current) throw new Error(`Unknown handoff: ${input.handoffId}`);

		const collab = getCollab(db, current.collabId);
		const maxRounds = collab?.orchestratorMaxRounds ?? current.maxRounds;

		db.prepare(
			`UPDATE relay_handoff
			    SET orchestrator_status = 'processed',
			        orchestrator_verdict = 'escalate',
			        orchestrator_reason = ?,
			        orchestrator_evaluated_at = ?
			  WHERE handoff_id = ?`,
		).run(input.reason, input.evaluatedAt, input.handoffId);

		upsertRelayTurnState(db, {
			collabId: current.collabId,
			turnOwner: current.senderAgent,
			waitingAgent: null,
			unresolvedHandoffId: null,
			handoffState: "idle",
			orchestratorEnabled: true,
			currentRound: current.roundNumber ?? 1,
			maxRounds,
			chainStatus: "abandoned",
			updatedAt: input.evaluatedAt,
		});
	})();
}

/** Inserts a workflow-owned relay handoff and atomically updates relay_turn_state. */
export function insertWorkflowOwnedRelayHandoff(
	db: Database.Database,
	input: {
		handoffId: string;
		collabId: string;
		senderAgent: "claude" | "codex";
		targetAgent: "claude" | "codex";
		requestText: string;
		chainId: string;
		roundNumber: number;
		maxRounds: number;
		handoffStep: "review" | "fix" | "implement" | "execute";
		workflowId: string;
		phaseRunId: string;
		now: string;
	},
): void {
	db.prepare(
		`INSERT INTO relay_handoff
		 (handoff_id, collab_id, sender_agent, target_agent, request_text, status,
		  capture_status, chain_id, parent_handoff_id, round_number,
		  root_request_text, handback_text, orchestrator_status, orchestrator_verdict,
		  orchestrator_reason, orchestrator_claimed_at, orchestrator_evaluated_at,
		  handoff_step, workflow_id, phase_run_id,
		  evaluator_verdict, evaluator_confidence, evaluator_reason, evaluator_evaluated_at,
		  created_at, accepted_at, deferred_at, resolved_at, last_activity_at)
		 VALUES (?, ?, ?, ?, ?, 'pending',
		         NULL, ?, NULL, ?,
		         ?, NULL, 'idle', NULL,
		         NULL, NULL, NULL,
		         ?, ?, ?,
		         NULL, NULL, NULL, NULL,
		         ?, NULL, NULL, NULL, ?)`,
	).run(
		input.handoffId,
		input.collabId,
		input.senderAgent,
		input.targetAgent,
		input.requestText,
		input.chainId,
		input.roundNumber,
		input.requestText, // root_request_text on first handoff
		input.handoffStep,
		input.workflowId,
		input.phaseRunId,
		input.now,
		input.now,
	);

	// Callers must ensure the collab has no unresolved handoff before calling this.
	// Flip turn ownership so the mount surface sees the new handoff.
	upsertRelayTurnState(db, {
		collabId: input.collabId,
		turnOwner: input.targetAgent,
		waitingAgent: input.senderAgent,
		unresolvedHandoffId: input.handoffId,
		handoffState: "pending",
		updatedAt: input.now,
		orchestratorEnabled: true,
		currentRound: input.roundNumber,
		maxRounds: input.maxRounds,
		chainStatus: "active",
	});
}

export function getHandoffWithWorkflowMetaById(
	db: Database.Database,
	handoffId: string,
): (RelayHandoffRecord & {
	handoffStep: "review" | "fix" | "implement" | "execute" | null;
	workflowId: string | null;
	phaseRunId: string | null;
	phaseName: string | null;
	evaluatorVerdict: string | null;
	evaluatorConfidence: number | null;
	evaluatorReason: string | null;
}) | null {
	const row = db
		.prepare(
			`SELECT h.handoff_id, h.collab_id, h.sender_agent, h.target_agent, h.request_text, h.status,
			        h.capture_status, h.chain_id, h.parent_handoff_id, h.round_number, h.root_request_text,
			        h.handback_text, h.orchestrator_status, h.orchestrator_verdict, h.orchestrator_reason,
			        h.orchestrator_claimed_at, h.orchestrator_evaluated_at, h.created_at, h.accepted_at,
			        h.deferred_at, h.resolved_at, h.last_activity_at,
			        h.handoff_step, h.workflow_id, h.phase_run_id,
			        h.evaluator_verdict, h.evaluator_confidence, h.evaluator_reason, h.evaluator_evaluated_at,
			        wp.phase_name,
			        COALESCE(rc.max_rounds, c.orchestrator_max_rounds) AS max_rounds
			 FROM relay_handoff h
			 JOIN collab c ON c.collab_id = h.collab_id
			 LEFT JOIN relay_chains rc ON rc.chain_id = h.chain_id
			 LEFT JOIN workflow_phases wp ON wp.phase_run_id = h.phase_run_id
			 WHERE h.handoff_id = ?`,
		)
		.get(handoffId) as
		| (Parameters<typeof rowToRecord>[0] & {
				handoff_step: string | null;
				workflow_id: string | null;
				phase_run_id: string | null;
				phase_name: string | null;
				evaluator_verdict: string | null;
				evaluator_confidence: number | null;
				evaluator_reason: string | null;
				evaluator_evaluated_at: string | null;
		  })
		| undefined;
	if (!row) return null;
	const base = rowToRecord(row);
	return {
		...base,
		handoffStep: row.handoff_step as "review" | "fix" | "implement" | "execute" | null,
		workflowId: row.workflow_id,
		phaseRunId: row.phase_run_id,
		phaseName: row.phase_name,
		evaluatorVerdict: row.evaluator_verdict,
		evaluatorConfidence: row.evaluator_confidence,
		evaluatorReason: row.evaluator_reason,
	};
}

export function updateEvaluatorBookkeeping(
	db: Database.Database,
	input: {
		handoffId: string;
		evaluatorVerdict: string;
		evaluatorConfidence: number;
		evaluatorReason: string;
		evaluatorEvaluatedAt: string;
		legacyVerdict: "done" | "loop" | "escalate";
	},
): void {
	db.prepare(
		`UPDATE relay_handoff
		   SET evaluator_verdict = ?,
		       evaluator_confidence = ?,
		       evaluator_reason = ?,
		       evaluator_evaluated_at = ?,
		       orchestrator_status = 'processed',
		       orchestrator_verdict = ?,
		       -- Mirror reason to legacy column for backward-compatible reporting.
		       orchestrator_reason = ?,
		       orchestrator_evaluated_at = ?
		 WHERE handoff_id = ?`,
	).run(
		input.evaluatorVerdict,
		input.evaluatorConfidence,
		input.evaluatorReason,
		input.evaluatorEvaluatedAt,
		input.legacyVerdict,
		input.evaluatorReason,
		input.evaluatorEvaluatedAt,
		input.handoffId,
	);
}

export function structuredVerdictToLegacy(
	v: "approve" | "findings" | "delivered" | "execution-pass" | "execution-fail" | "escalate",
): "done" | "loop" | "escalate" {
	if (v === "approve" || v === "execution-pass") return "done";
	if (v === "findings" || v === "delivered") return "loop";
	return "escalate";
}

export type RelayHandoffCursor = { createdAt: string; handoffId: string };

export type RelayHandoffLogRow = {
	handoffId: string;
	createdAt: string;
	collabId: string;
	senderAgent: "codex" | "claude";
	targetAgent: "codex" | "claude";
	status: string;
	captureStatus: string | null;
	chainId: string | null;
	roundNumber: number | null;
	handoffStep: string | null;
	workflowId: string | null;
	phaseRunId: string | null;
	handbackText: string | null;
	evaluatorVerdict: string | null;
	evaluatorConfidence: number | null;
	evaluatorReason: string | null;
};

type LogDbRow = {
	handoff_id: string;
	created_at: string;
	collab_id: string;
	sender_agent: string;
	target_agent: string;
	status: string;
	capture_status: string | null;
	chain_id: string | null;
	round_number: number | null;
	handoff_step: string | null;
	workflow_id: string | null;
	phase_run_id: string | null;
	handback_text: string | null;
	evaluator_verdict: string | null;
	evaluator_confidence: number | null;
	evaluator_reason: string | null;
};

export function listRelayHandoffs(
	db: Database.Database,
	input: { collabId: string; afterCursor?: RelayHandoffCursor },
): RelayHandoffLogRow[] {
	const cols = `handoff_id, created_at, collab_id, sender_agent, target_agent, status,
		capture_status, chain_id, round_number, handoff_step, workflow_id,
		phase_run_id, handback_text, evaluator_verdict, evaluator_confidence,
		evaluator_reason`;
	const order = "ORDER BY created_at ASC, handoff_id ASC";
	const rows = (
		input.afterCursor
			? db
					.prepare(
						`SELECT ${cols} FROM relay_handoff
						 WHERE collab_id = ?
						   AND (created_at > ? OR (created_at = ? AND handoff_id > ?))
						 ${order}`,
					)
					.all(
						input.collabId,
						input.afterCursor.createdAt,
						input.afterCursor.createdAt,
						input.afterCursor.handoffId,
					)
			: db
					.prepare(`SELECT ${cols} FROM relay_handoff WHERE collab_id = ? ${order}`)
					.all(input.collabId)
	) as LogDbRow[];

	return rows.map((r) => ({
		handoffId: r.handoff_id,
		createdAt: r.created_at,
		collabId: r.collab_id,
		senderAgent: r.sender_agent as "codex" | "claude",
		targetAgent: r.target_agent as "codex" | "claude",
		status: r.status,
		captureStatus: r.capture_status,
		chainId: r.chain_id,
		roundNumber: r.round_number,
		handoffStep: r.handoff_step,
		workflowId: r.workflow_id,
		phaseRunId: r.phase_run_id,
		handbackText: r.handback_text,
		evaluatorVerdict: r.evaluator_verdict,
		evaluatorConfidence: r.evaluator_confidence,
		evaluatorReason: r.evaluator_reason,
	}));
}

export function cleanupOrchestrationOnShutdownTxn(
	db: Database.Database,
	input: { collabId: string; reason: string; now: string },
): void {
	db.transaction(() => {
		const rows = db
			.prepare(
				`SELECT h.handoff_id, h.collab_id, h.sender_agent, h.round_number,
				        c.orchestrator_max_rounds AS max_rounds
				   FROM relay_handoff h
				   JOIN collab c ON c.collab_id = h.collab_id
				  WHERE h.collab_id = ?
				    AND h.status = 'handed_back'
				    AND h.orchestrator_status IN ('idle', 'pending')`,
			)
			.all(input.collabId) as Array<{
			handoff_id: string;
			collab_id: string;
			sender_agent: string;
			round_number: number | null;
			max_rounds: number;
		}>;

		for (const row of rows) {
			db.prepare(
				`UPDATE relay_handoff
				    SET orchestrator_status = 'processed',
				        orchestrator_verdict = 'escalate',
				        orchestrator_reason = ?,
				        orchestrator_evaluated_at = ?
				  WHERE handoff_id = ?`,
			).run(input.reason, input.now, row.handoff_id);

			upsertRelayTurnState(db, {
				collabId: row.collab_id,
				turnOwner: row.sender_agent as "codex" | "claude",
				waitingAgent: null,
				unresolvedHandoffId: null,
				handoffState: "idle",
				orchestratorEnabled: true,
				currentRound: row.round_number ?? 1,
				maxRounds: row.max_rounds,
				chainStatus: "abandoned",
				updatedAt: input.now,
			});
		}
	})();
}
