import type { BrokerRuntime } from "./create-broker-runtime.js";
import type { WorkspaceHeadReader } from "./workspace-head-reader.js";
import {
	getWorkflowDefinition,
	derivePlanPath,
	renderTemplate,
} from "./workflow-registry.js";

export interface WorkflowDriverDeps {
	broker: BrokerRuntime;
	headReader: WorkspaceHeadReader;
	/** Interval (ms) for the recovery sweep. 0 = disabled. */
	sweepIntervalMs: number;
}

export interface WorkflowDriver {
	start(): void;
	stop(): void;
}

export function createWorkflowDriver(deps: WorkflowDriverDeps): WorkflowDriver {
	const { broker, headReader, sweepIntervalMs } = deps;
	let sweepTimer: ReturnType<typeof setInterval> | null = null;
	const unsubscribers: Array<() => void> = [];

	async function kickoffCurrentPhase(workflowId: string): Promise<void> {
		const now = new Date().toISOString();
		const workflow = broker.control.getWorkflow(workflowId);
		if (!workflow || workflow.status !== "running") {
			return;
		}

		// Guard: already has an open phase run for this index
		const existingRuns = broker.control.getWorkflowPhaseRuns(workflowId);
		const hasOpenRun = existingRuns.some(
			(r) => r.phaseIndex === workflow.currentPhaseIndex && r.endedAt === null,
		);
		if (hasOpenRun) {
			return;
		}

		const definition = getWorkflowDefinition(workflow.workflowType);
		if (!definition) {
			broker.control.haltWorkflow({
				workflowId,
				reason: `unknown workflow type: ${workflow.workflowType}`,
				now,
			});
			return;
		}

		const phase = definition.phases[workflow.currentPhaseIndex];
		if (!phase) {
			// No more phases — shouldn't happen for a running workflow, but guard anyway.
			return;
		}

		// Validate bindings for all roles the phase needs.
		const collab = broker.control.getCollab(workflow.collabId);
		if (!collab) {
			broker.control.haltWorkflow({
				workflowId,
				reason: `collab ${workflow.collabId} not found`,
				now,
			});
			return;
		}

		const bindings = broker.control.listSessionBindings(workflow.collabId);

		const implementerAgent = workflow.roleBindings.implementer;
		const reviewerAgent = workflow.roleBindings.reviewer;
		if (!implementerAgent || !reviewerAgent) {
			broker.control.haltWorkflow({
				workflowId,
				reason: "missing implementer or reviewer role binding",
				now,
			});
			return;
		}

		const isAgentBound = (agent: "claude" | "codex"): boolean =>
			bindings.some((b) => b.agentType === agent && b.bindingState === "bound");

		// Check implementer binding
		if (implementerAgent && !isAgentBound(implementerAgent)) {
			broker.control.haltWorkflow({
				workflowId,
				reason: `implementer agent "${implementerAgent}" is not bound on collab ${workflow.collabId}`,
				now,
			});
			return;
		}

		// Check reviewer binding if phase requires one
		if (phase.reviewerRole !== null && reviewerAgent && !isAgentBound(reviewerAgent)) {
			broker.control.haltWorkflow({
				workflowId,
				reason: `reviewer agent "${reviewerAgent}" is not bound on collab ${workflow.collabId}`,
				now,
			});
			return;
		}

		// Determine sender/target from phase initialHandoffStep
		const sender: "claude" | "codex" =
			phase.initialHandoffStep === "review"
				? (implementerAgent as "claude" | "codex")
				: (reviewerAgent as "claude" | "codex");
		const target: "claude" | "codex" =
			phase.initialHandoffStep === "review"
				? (reviewerAgent as "claude" | "codex")
				: (implementerAgent as "claude" | "codex");

		// Read HEAD sha for execute phases
		let executionBaseHeadSha: string | undefined;
		if (phase.initialHandoffStep === "execute") {
			try {
				executionBaseHeadSha = await headReader.readHead(collab.workspaceRoot);
			} catch (err) {
				broker.control.haltWorkflow({
					workflowId,
					reason: `failed to read workspace HEAD: ${String(err)}`,
					now,
				});
				return;
			}
		}

		// Render kickoff text
		const ctx = workflow.workflowContext as { commitRange?: string };
		let planPath = workflow.specPath; // safe fallback
		try {
			planPath = derivePlanPath(workflow.specPath, workflow.createdAt);
		} catch {
			// specPath doesn't follow the -design.md convention; use specPath as fallback
		}
		const kickoffText = renderTemplate(phase.kickoffTemplate, {
			specPath: workflow.specPath,
			planPath,
			commitRange: ctx.commitRange ?? "HEAD",
		});

		try {
			broker.control.beginPhaseRun({
				workflowId,
				phaseIndex: workflow.currentPhaseIndex,
				phaseName: phase.name,
				initialHandoffStep: phase.initialHandoffStep,
				kickoffText,
				sender,
				target,
				maxRounds: phase.maxRounds,
				executionBaseHeadSha,
				now,
			});
		} catch (err) {
			// beginPhaseRun throws if an open phase run already exists — that's fine.
			const msg = err instanceof Error ? err.message : String(err);
			if (!msg.includes("open phase run already exists")) {
				console.error(`[workflow-driver] beginPhaseRun error for ${workflowId}:`, err);
			}
		}
	}

	async function sweep(): Promise<void> {
		const running = broker.control.listWorkflows({ status: "running" });
		for (const workflow of running) {
			const runs = broker.control.getWorkflowPhaseRuns(workflow.workflowId);
			const hasOpen = runs.some(
				(r) => r.phaseIndex === workflow.currentPhaseIndex && r.endedAt === null,
			);
			if (!hasOpen) {
				await kickoffCurrentPhase(workflow.workflowId);
			}
		}
	}

	return {
		start() {
			const unsub = broker.events.on("workflow.created", ({ workflowId }) => {
				setImmediate(() => void kickoffCurrentPhase(workflowId));
			});
			unsubscribers.push(unsub);
			unsubscribers.push(
				broker.events.on("workflow.resumed", (e) =>
					setImmediate(() => void kickoffCurrentPhase(e.workflowId)),
				),
			);

			if (sweepIntervalMs > 0) {
				sweepTimer = setInterval(() => {
					void sweep();
				}, sweepIntervalMs);
			}
		},
		stop() {
			for (const unsub of unsubscribers) {
				unsub();
			}
			unsubscribers.length = 0;
			if (sweepTimer !== null) {
				clearInterval(sweepTimer);
				sweepTimer = null;
			}
		},
	};
}
