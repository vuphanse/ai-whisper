import type Database from "better-sqlite3";
import { basename } from "node:path";

export type CollabSummary = {
	collabId: string;
	label: string;
	workflowId: string | null;
	workflowType: string | null;
	workflowStatus: "running" | "done" | "halted" | "canceled" | null;
	currentPhaseRunId: string | null;
	phaseIndex: number | null;
	phaseName: string | null;
	currentRound: number | null;
	maxRounds: number | null;
	chainStatus: "active" | "done" | "escalated" | "abandoned" | null;
	turn: {
		owner: "codex" | "claude" | "none";
		waiting: "codex" | "claude" | null;
		handoffState: string;
	};
	sessions: Array<{ agentType: string; healthState: string }>;
	lastActivityAt: string;
};

export type RunCostRow = {
	phaseRunId: string | null;
	createdAt: string;
	resolvedAt: string | null;
	lastActivityAt: string;
	inChars: number;
	outChars: number;
};

// Eligible = a workflow is `running`, OR the collab had relay activity within
// the recency window. Resolution mirrors the #1 host: running workflow (unique
// per the schema index) → else most-recent workflow → else manual-relay (null).
// All reads are CURRENT rows (no cursor) so in-place mutations are reflected.
export function listActiveCollabSummaries(
	db: Database.Database,
	input: { sinceMs: number; now?: string },
): CollabSummary[] {
	const nowMs = Date.parse(input.now ?? new Date().toISOString());
	const cutoff = new Date(
		Number.isFinite(nowMs) ? nowMs - input.sinceMs : Date.now() - input.sinceMs,
	).toISOString();

	const eligible = db
		.prepare(
			`SELECT c.collab_id AS collabId,
			        COALESCE(MAX(h.last_activity_at), '') AS lastAct
			   FROM collab c
			   LEFT JOIN relay_handoff h ON h.collab_id = c.collab_id
			  GROUP BY c.collab_id
			 HAVING MAX(h.last_activity_at) >= ?
			     OR EXISTS (SELECT 1 FROM workflows w
			                 WHERE w.collab_id = c.collab_id AND w.status = 'running')`,
		)
		.all(cutoff) as Array<{ collabId: string; lastAct: string }>;

	const out: CollabSummary[] = [];
	for (const e of eligible) {
		const collab = db
			.prepare(
				`SELECT display_name AS displayName, workspace_root AS workspaceRoot
				   FROM collab WHERE collab_id = ?`,
			)
			.get(e.collabId) as { displayName: string; workspaceRoot: string } | undefined;

		const wf = db
			.prepare(
				`SELECT workflow_id AS workflowId, workflow_type AS workflowType,
				        name, status, current_phase_index AS currentPhaseIndex
				   FROM workflows WHERE collab_id = ?
				  ORDER BY (status = 'running') DESC, created_at DESC
				  LIMIT 1`,
			)
			.get(e.collabId) as
			| {
					workflowId: string;
					workflowType: string;
					name: string | null;
					status: "running" | "done" | "halted" | "canceled";
					currentPhaseIndex: number;
				}
			| undefined;

		let currentPhaseRunId: string | null = null;
		let phaseIndex: number | null = null;
		let phaseName: string | null = null;
		let chainId: string | null = null;
		if (wf) {
			const ph = db
				.prepare(
					`SELECT phase_run_id AS phaseRunId, phase_index AS phaseIndex,
					        phase_name AS phaseName, chain_id AS chainId
					   FROM workflow_phases WHERE workflow_id = ?
					  ORDER BY (ended_at IS NULL) DESC, started_at DESC
					  LIMIT 1`,
				)
				.get(wf.workflowId) as
				| { phaseRunId: string; phaseIndex: number; phaseName: string; chainId: string }
				| undefined;
			if (ph) {
				currentPhaseRunId = ph.phaseRunId;
				phaseIndex = ph.phaseIndex;
				phaseName = ph.phaseName;
				chainId = ph.chainId;
			}
		}

		const chain = chainId
			? (db
					.prepare(
						`SELECT status, current_round AS currentRound, max_rounds AS maxRounds
						   FROM relay_chains WHERE chain_id = ?`,
					)
					.get(chainId) as
					| {
							status: "active" | "done" | "escalated" | "abandoned";
							currentRound: number;
							maxRounds: number;
						}
					| undefined)
			: undefined;

		const turn = db
			.prepare(
				`SELECT turn_owner AS owner, waiting_agent AS waiting, handoff_state AS handoffState
				   FROM relay_turn_state WHERE collab_id = ?`,
			)
			.get(e.collabId) as
			| { owner: "codex" | "claude" | "none"; waiting: "codex" | "claude" | null; handoffState: string }
			| undefined;

		const sessions = db
			.prepare(
				`SELECT agent_type AS agentType, health_state AS healthState
				   FROM session WHERE collab_id = ? ORDER BY registered_at ASC`,
			)
			.all(e.collabId) as Array<{ agentType: string; healthState: string }>;

		const label =
			(wf?.name && wf.name.trim()) ||
			(collab?.displayName && collab.displayName.trim()) ||
			(collab?.workspaceRoot ? basename(collab.workspaceRoot) : "") ||
			e.collabId.slice(0, 12);

		out.push({
			collabId: e.collabId,
			label,
			workflowId: wf?.workflowId ?? null,
			workflowType: wf?.workflowType ?? null,
			workflowStatus: wf?.status ?? null,
			currentPhaseRunId,
			phaseIndex,
			phaseName,
			currentRound: chain?.currentRound ?? null,
			maxRounds: chain?.maxRounds ?? null,
			chainStatus: chain?.status ?? null,
			turn: {
				owner: turn?.owner ?? "none",
				waiting: turn?.waiting ?? null,
				handoffState: turn?.handoffState ?? "idle",
			},
			sessions,
			lastActivityAt: e.lastAct,
		});
	}
	return out;
}
