import type Database from "better-sqlite3";

export type WorkflowPhaseOutcome = "done" | "escalated" | "superseded";

export type WorkflowPhaseRunRecord = {
	phaseRunId: string;
	workflowId: string;
	phaseIndex: number;
	phaseName: string;
	chainId: string;
	startedAt: string;
	endedAt: string | null;
	outcome: WorkflowPhaseOutcome | null;
};

function rowToRecord(row: {
	phase_run_id: string;
	workflow_id: string;
	phase_index: number;
	phase_name: string;
	chain_id: string;
	started_at: string;
	ended_at: string | null;
	outcome: string | null;
}): WorkflowPhaseRunRecord {
	return {
		phaseRunId: row.phase_run_id,
		workflowId: row.workflow_id,
		phaseIndex: row.phase_index,
		phaseName: row.phase_name,
		chainId: row.chain_id,
		startedAt: row.started_at,
		endedAt: row.ended_at,
		outcome: row.outcome as WorkflowPhaseOutcome | null,
	};
}

export function insertWorkflowPhaseRun(
	db: Database.Database,
	input: {
		phaseRunId: string;
		workflowId: string;
		phaseIndex: number;
		phaseName: string;
		chainId: string;
		now: string;
	},
): void {
	db.prepare(
		`INSERT INTO workflow_phases
		 (phase_run_id, workflow_id, phase_index, phase_name, chain_id, started_at, ended_at, outcome)
		 VALUES (?, ?, ?, ?, ?, ?, NULL, NULL)`,
	).run(
		input.phaseRunId,
		input.workflowId,
		input.phaseIndex,
		input.phaseName,
		input.chainId,
		input.now,
	);
}

export function getLatestPhaseRunForIndex(
	db: Database.Database,
	input: { workflowId: string; phaseIndex: number },
): WorkflowPhaseRunRecord | null {
	const row = db
		.prepare(
			`SELECT * FROM workflow_phases
			 WHERE workflow_id = ? AND phase_index = ?
			 ORDER BY started_at DESC LIMIT 1`,
		)
		.get(input.workflowId, input.phaseIndex) as
		| Parameters<typeof rowToRecord>[0]
		| undefined;
	return row ? rowToRecord(row) : null;
}

export function listPhaseRunsForWorkflow(
	db: Database.Database,
	workflowId: string,
): WorkflowPhaseRunRecord[] {
	const rows = db
		.prepare(
			"SELECT * FROM workflow_phases WHERE workflow_id = ? ORDER BY started_at ASC",
		)
		.all(workflowId) as Array<Parameters<typeof rowToRecord>[0]>;
	return rows.map(rowToRecord);
}

export function closeWorkflowPhaseRun(
	db: Database.Database,
	input: { phaseRunId: string; outcome: WorkflowPhaseOutcome; now: string },
): void {
	db.prepare(
		"UPDATE workflow_phases SET ended_at = ?, outcome = ? WHERE phase_run_id = ?",
	).run(input.now, input.outcome, input.phaseRunId);
}

export function hasOpenPhaseRunForIndex(
	db: Database.Database,
	input: { workflowId: string; phaseIndex: number },
): boolean {
	const row = db
		.prepare(
			`SELECT 1 FROM workflow_phases
			 WHERE workflow_id = ? AND phase_index = ? AND ended_at IS NULL
			 LIMIT 1`,
		)
		.get(input.workflowId, input.phaseIndex);
	return row !== undefined;
}
