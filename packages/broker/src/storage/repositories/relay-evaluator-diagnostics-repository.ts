import type Database from "better-sqlite3";

export type EvaluatorOutcome =
	| "ok"
	| "parse_error"
	| "validation_error"
	| "provider_unavailable"
	| "unknown_error";

export type RelayEvaluatorDiagnosticRecord = {
	evaluatorId: string;
	handoffId: string;
	collabId: string;
	chainId: string | null;
	workflowId: string | null;
	phaseRunId: string | null;
	evaluatorBranch: "legacy" | "review" | "delivered" | "execution";
	evaluatorPromptKey: "review-loop" | "execution-gate" | null;
	handoffStep: "review" | "fix" | "implement" | "execute" | null;
	attemptKind: "primary" | "fallback";
	callGroupId: string;
	provider: "anthropic" | "ollama";
	outcome: EvaluatorOutcome;
	verdict: string | null;
	confidence: number | null;
	reason: string | null;
	followUpMessageLen: number | null;
	latencyMs: number;
	errorMessage: string | null;
	inputTokens: number | null;
	outputTokens: number | null;
	promptSample: string | null;
	responseSample: string | null;
	createdAt: string;
};

type Row = {
	evaluator_id: string;
	handoff_id: string;
	collab_id: string;
	chain_id: string | null;
	workflow_id: string | null;
	phase_run_id: string | null;
	evaluator_branch: string;
	evaluator_prompt_key: string | null;
	handoff_step: string | null;
	attempt_kind: string;
	call_group_id: string;
	provider: string;
	outcome: string;
	verdict: string | null;
	confidence: number | null;
	reason: string | null;
	follow_up_message_len: number | null;
	latency_ms: number;
	error_message: string | null;
	input_tokens: number | null;
	output_tokens: number | null;
	prompt_sample: string | null;
	response_sample: string | null;
	created_at: string;
};

function rowToRecord(row: Row): RelayEvaluatorDiagnosticRecord {
	return {
		evaluatorId: row.evaluator_id,
		handoffId: row.handoff_id,
		collabId: row.collab_id,
		chainId: row.chain_id,
		workflowId: row.workflow_id,
		phaseRunId: row.phase_run_id,
		evaluatorBranch: row.evaluator_branch as RelayEvaluatorDiagnosticRecord["evaluatorBranch"],
		evaluatorPromptKey: row.evaluator_prompt_key as RelayEvaluatorDiagnosticRecord["evaluatorPromptKey"],
		handoffStep: row.handoff_step as RelayEvaluatorDiagnosticRecord["handoffStep"],
		attemptKind: row.attempt_kind as "primary" | "fallback",
		callGroupId: row.call_group_id,
		provider: row.provider as "anthropic" | "ollama",
		outcome: row.outcome as EvaluatorOutcome,
		verdict: row.verdict,
		confidence: row.confidence,
		reason: row.reason,
		followUpMessageLen: row.follow_up_message_len,
		latencyMs: row.latency_ms,
		errorMessage: row.error_message,
		inputTokens: row.input_tokens,
		outputTokens: row.output_tokens,
		promptSample: row.prompt_sample,
		responseSample: row.response_sample,
		createdAt: row.created_at,
	};
}

export function insertEvaluatorDiagnostic(
	db: Database.Database,
	input: RelayEvaluatorDiagnosticRecord,
): void {
	db.prepare(
		`INSERT INTO relay_evaluator_diagnostics
		 (evaluator_id, handoff_id, collab_id, chain_id, workflow_id, phase_run_id,
		  evaluator_branch, evaluator_prompt_key, handoff_step, attempt_kind, call_group_id,
		  provider, outcome, verdict, confidence, reason, follow_up_message_len,
		  latency_ms, error_message, input_tokens, output_tokens,
		  prompt_sample, response_sample, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.evaluatorId,
		input.handoffId,
		input.collabId,
		input.chainId,
		input.workflowId,
		input.phaseRunId,
		input.evaluatorBranch,
		input.evaluatorPromptKey,
		input.handoffStep,
		input.attemptKind,
		input.callGroupId,
		input.provider,
		input.outcome,
		input.verdict,
		input.confidence,
		input.reason,
		input.followUpMessageLen,
		input.latencyMs,
		input.errorMessage,
		input.inputTokens,
		input.outputTokens,
		input.promptSample,
		input.responseSample,
		input.createdAt,
	);
}

export function listEvaluatorDiagnosticsByCollab(
	db: Database.Database,
	collabId: string,
	limit: number | null,
): RelayEvaluatorDiagnosticRecord[] {
	if (limit === null) {
		const rows = db
			.prepare(
				`SELECT * FROM relay_evaluator_diagnostics
				 WHERE collab_id = ?
				 ORDER BY created_at DESC`,
			)
			.all(collabId) as Row[];
		return rows.map(rowToRecord);
	}
	const rows = db
		.prepare(
			`SELECT * FROM relay_evaluator_diagnostics
			 WHERE collab_id = ?
			 ORDER BY created_at DESC
			 LIMIT ?`,
		)
		.all(collabId, limit) as Row[];
	return rows.map(rowToRecord);
}

export function listEvaluatorDiagnosticsByCollabAndChain(
	db: Database.Database,
	collabId: string,
	chainId: string,
	limit: number | null,
): RelayEvaluatorDiagnosticRecord[] {
	if (limit === null) {
		const rows = db
			.prepare(
				`SELECT * FROM relay_evaluator_diagnostics
				 WHERE collab_id = ? AND chain_id = ?
				 ORDER BY created_at DESC`,
			)
			.all(collabId, chainId) as Row[];
		return rows.map(rowToRecord);
	}
	const rows = db
		.prepare(
			`SELECT * FROM relay_evaluator_diagnostics
			 WHERE collab_id = ? AND chain_id = ?
			 ORDER BY created_at DESC
			 LIMIT ?`,
		)
		.all(collabId, chainId, limit) as Row[];
	return rows.map(rowToRecord);
}

export function listEvaluatorDiagnosticsByHandoff(
	db: Database.Database,
	handoffId: string,
): RelayEvaluatorDiagnosticRecord[] {
	const rows = db
		.prepare(
			`SELECT * FROM relay_evaluator_diagnostics
			 WHERE handoff_id = ?
			 ORDER BY created_at ASC`,
		)
		.all(handoffId) as Row[];
	return rows.map(rowToRecord);
}

export function deleteEvaluatorDiagnosticsOlderThan(
	db: Database.Database,
	cutoffIso: string,
): number {
	const result = db
		.prepare("DELETE FROM relay_evaluator_diagnostics WHERE created_at < ?")
		.run(cutoffIso);
	return result.changes;
}
