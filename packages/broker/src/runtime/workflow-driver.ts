import type { WorkspaceHeadReader } from "./workspace-head-reader.js";
import type { BrokerEventBus } from "./broker-event-bus.js";
import {
	getWorkflowDefinition,
	derivePlanPath,
	renderTemplate,
	ralphRunDir,
} from "./workflow-registry.js";
import { ensureRalphWorkspace } from "./ralph-setup.js";

type WorkflowStatus = "running" | "halted" | "done" | "canceled";
type WorkflowRecordLike = {
	workflowId: string;
	collabId: string;
	workflowType: string;
	currentPhaseIndex: number;
	status: WorkflowStatus;
	specPath: string;
	roleBindings: Record<string, "claude" | "codex">;
	workflowContext: Record<string, unknown>;
	createdAt: string;
	haltReason: string | null;
};

export interface WorkflowDriverDeps {
	broker: {
		control: {
			getWorkflow: (id: string) => WorkflowRecordLike | null | undefined;
			listWorkflows: (filter?: { status?: WorkflowStatus }) => WorkflowRecordLike[];
			getWorkflowPhaseRuns: (id: string) => Array<{ phaseIndex: number; endedAt: string | null }>;
			beginPhaseRun: (input: { workflowId: string; phaseIndex: number; phaseName: string; initialHandoffStep: "review" | "fix" | "implement" | "execute"; kickoffText: string; sender: "claude" | "codex"; target: "claude" | "codex"; maxRounds: number; executionBaseHeadSha?: string; now: string }) => { phaseRunId: string; chainId: string; handoffId: string };
			haltWorkflow: (input: { workflowId: string; reason: string; now: string }) => void;
			listSessionBindings: (collabId: string) => Array<{ agentType: string; bindingState: string }>;
			getCollab: (collabId: string) => { workspaceRoot: string } | null;
		};
		events: BrokerEventBus;
	};
	headReader: WorkspaceHeadReader;
	/** Interval (ms) for the recovery sweep. 0 = disabled. */
	sweepIntervalMs?: number;
	now?: () => string;
}

export interface WorkflowDriver {
	start(): void;
	stop(): void;
}

export function createWorkflowDriver(deps: WorkflowDriverDeps): WorkflowDriver {
	const { broker, headReader } = deps;
	const sweepIntervalMs = deps.sweepIntervalMs ?? 30_000;
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
				? (implementerAgent)
				: (reviewerAgent);
		const target: "claude" | "codex" =
			phase.initialHandoffStep === "review"
				? (reviewerAgent)
				: (implementerAgent);

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

		// Set up ralph workspace (idempotent) for looping phases; halt on fs failure.
		let ralphDir = "";
		if (phase.repeatUntilComplete) {
			try {
				ralphDir = ensureRalphWorkspace(collab.workspaceRoot, workflowId);
			} catch (err) {
				broker.control.haltWorkflow({ workflowId, reason: `ralph setup failed: ${String(err)}`, now });
				return;
			}
		} else {
			ralphDir = ralphRunDir(collab.workspaceRoot, workflowId);
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
			ralphDir,
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
				...(executionBaseHeadSha !== undefined
					? { executionBaseHeadSha }
					: {}),
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
