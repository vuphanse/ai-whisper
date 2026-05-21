import type Database from "better-sqlite3";
import { getBrokerDaemonByCollab, getWorkflowDefinition } from "@ai-whisper/broker";
import {
	isEvaluatorPreflightBlocked,
	type EvaluatorStatus,
} from "../../runtime/evaluator-config.js";

const EVALUATOR_README_HINT = "See the README \"Evaluator configuration\" section for details.";

export interface WorkflowStartDeps {
	broker: {
		db: Database.Database;
		control: {
			createWorkflow: (input: {
				collabId: string;
				workflowType: string;
				name?: string;
				specPath: string;
				roleBindings: { implementer: "claude" | "codex"; reviewer: "claude" | "codex" };
				now: string;
			}) => { workflowId: string };
		};
	};
	collabId: string;
	workflowType: string;
	specPath: string;
	implementer?: "claude" | "codex";
	reviewer?: "claude" | "codex";
	name?: string;
	now: string;
}

// eslint-disable-next-line @typescript-eslint/require-await
export async function runWorkflowStart(deps: WorkflowStartDeps): Promise<{ workflowId: string }> {
	// Preflight: bail early on an unconfigured evaluator so users get an
	// actionable remediation instead of an ~80s mid-run LLM-evaluation halt.
	const daemon = getBrokerDaemonByCollab(deps.broker.db, deps.collabId);
	const evaluatorStatus = (daemon?.evaluatorStatus ?? "unknown") as EvaluatorStatus;
	if (isEvaluatorPreflightBlocked(evaluatorStatus)) {
		if (evaluatorStatus === "missing_anthropic_key") {
			throw new Error(
				"Evaluator is not configured: ANTHROPIC_API_KEY is missing. " +
					"Add it to ~/.ai-whisper/auth.json as { \"ANTHROPIC_API_KEY\": \"sk-ant-...\" } " +
					"(mode 600), then restart the daemon: whisper collab stop and re-mount. " +
					EVALUATOR_README_HINT,
			);
		} else {
			// invalid_config
			throw new Error(
				"Evaluator configuration is invalid: ~/.ai-whisper/auth.json or config.json " +
					"contains malformed JSON. Fix the file, then restart the daemon: " +
					"whisper collab stop and re-mount. " +
					EVALUATOR_README_HINT,
			);
		}
	}

	const def = getWorkflowDefinition(deps.workflowType);
	const implementer = deps.implementer ?? def?.defaultImplementer;
	const reviewer = deps.reviewer ?? def?.defaultReviewer;
	if (!implementer || !reviewer) {
		throw new Error(
			`Workflow type "${deps.workflowType}" has no default role bindings. Pass --implementer and --reviewer explicitly.`,
		);
	}
	return deps.broker.control.createWorkflow({
		collabId: deps.collabId,
		workflowType: deps.workflowType,
		specPath: deps.specPath,
		roleBindings: { implementer, reviewer },
		...(deps.name ? { name: deps.name } : {}),
		now: deps.now,
	});
}
