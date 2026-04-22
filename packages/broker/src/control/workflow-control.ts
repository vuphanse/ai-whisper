import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getCollab } from "../storage/repositories/collab-repository.js";
import { listSessionBindingsForCollab } from "../storage/repositories/session-binding-repository.js";
import {
	insertWorkflow,
	getWorkflowById,
	listWorkflows as listWorkflowsRepo,
	countRunningWorkflowsForCollab,
	updateWorkflowContext,
	type WorkflowRecord,
	type WorkflowStatus,
} from "../storage/repositories/workflow-repository.js";
import {
	insertWorkflowPhaseRun,
	listPhaseRunsForWorkflow,
	hasOpenPhaseRunForIndex,
	type WorkflowPhaseRunRecord,
} from "../storage/repositories/workflow-phase-repository.js";
import {
	insertRelayChain,
	getRelayChain as getRelayChainRepo,
	type RelayChainRecord,
} from "../storage/repositories/relay-chain-repository.js";
import { insertWorkflowOwnedRelayHandoff } from "../storage/repositories/relay-handoff-repository.js";
import {
	getWorkflowDefinition,
	listWorkflowTypes,
} from "../runtime/workflow-registry.js";
import type { BrokerEventBus } from "../runtime/broker-event-bus.js";

export interface WorkflowControlDeps {
	db: Database.Database;
	events: BrokerEventBus;
}

const SHA_REGEX = /^[0-9a-f]{7,40}$/;

export function createWorkflowControl(deps: WorkflowControlDeps) {
	const { db, events } = deps;

	function createWorkflow(input: {
		collabId: string;
		workflowType: string;
		name?: string;
		specPath: string;
		roleBindings: { implementer: "claude" | "codex"; reviewer: "claude" | "codex" };
		now: string;
	}): { workflowId: string } {
		const collab = getCollab(db, input.collabId);
		if (!collab) {
			throw new Error(`createWorkflow: unknown collabId ${input.collabId}`);
		}
		if (!collab.orchestratorEnabled) {
			throw new Error(
				"workflow requires orchestrator-enabled collab; enable AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED and restart broker",
			);
		}
		if (!getWorkflowDefinition(input.workflowType)) {
			throw new Error(
				`createWorkflow: unknown workflowType ${input.workflowType}. Available: ${listWorkflowTypes().join(", ")}`,
			);
		}

		const bindings = listSessionBindingsForCollab(db, input.collabId);
		for (const [role, agent] of Object.entries(input.roleBindings)) {
			const binding = bindings.find(
				(b) => b.agentType === agent && b.bindingState === "bound",
			);
			if (!binding) {
				throw new Error(
					`createWorkflow: role ${role} maps to agent ${agent} which is not bound on collab ${input.collabId}`,
				);
			}
		}

		const workflowId = `wf_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

		const tx = db.transaction(() => {
			if (countRunningWorkflowsForCollab(db, input.collabId) > 0) {
				throw new Error(
					`another workflow is already running on this collab (${input.collabId})`,
				);
			}
			insertWorkflow(db, {
				workflowId,
				collabId: input.collabId,
				workflowType: input.workflowType,
				name: input.name ?? null,
				specPath: input.specPath,
				roleBindings: input.roleBindings,
				status: "running",
				currentPhaseIndex: 0,
				workflowContext: {},
				now: input.now,
			});
		});
		// BEGIN IMMEDIATE acquires the write lock before the callback runs, making the
		// countRunningWorkflowsForCollab guard + insertWorkflow atomic against concurrent callers.
		tx.immediate();

		events.emit("workflow.created", { workflowId });
		return { workflowId };
	}

	function getWorkflow(workflowId: string): WorkflowRecord | null {
		return getWorkflowById(db, workflowId);
	}

	function listWorkflows(filter: {
		collabId?: string;
		status?: WorkflowStatus;
	} = {}): WorkflowRecord[] {
		return listWorkflowsRepo(db, filter);
	}

	function getWorkflowPhaseRuns(workflowId: string): WorkflowPhaseRunRecord[] {
		return listPhaseRunsForWorkflow(db, workflowId);
	}

	function getRelayChain(chainId: string): RelayChainRecord | null {
		return getRelayChainRepo(db, chainId);
	}

	function beginPhaseRun(input: {
		workflowId: string;
		phaseIndex: number;
		phaseName: string;
		initialHandoffStep: "review" | "fix" | "implement" | "execute";
		kickoffText: string;
		sender: "claude" | "codex";
		target: "claude" | "codex";
		maxRounds: number;
		executionBaseHeadSha?: string;
		now: string;
	}): { phaseRunId: string; chainId: string; handoffId: string } {
		if (input.initialHandoffStep === "execute") {
			if (!input.executionBaseHeadSha) {
				throw new Error(
					"beginPhaseRun(execute) requires executionBaseHeadSha",
				);
			}
			if (!SHA_REGEX.test(input.executionBaseHeadSha)) {
				throw new Error(
					`beginPhaseRun(execute): malformed executionBaseHeadSha: ${input.executionBaseHeadSha}`,
				);
			}
		}

		const workflow = getWorkflowById(db, input.workflowId);
		if (!workflow) {
			throw new Error(`beginPhaseRun: unknown workflowId ${input.workflowId}`);
		}
		if (workflow.status !== "running") {
			throw new Error(
				`beginPhaseRun: workflow ${input.workflowId} not running (status=${workflow.status})`,
			);
		}
		const chainId = `relay_ch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const phaseRunId = `wfp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const handoffId = `ho_${randomUUID().replace(/-/g, "").slice(0, 16)}`;

		const tx = db.transaction(() => {
			if (
				hasOpenPhaseRunForIndex(db, {
					workflowId: input.workflowId,
					phaseIndex: input.phaseIndex,
				})
			) {
				throw new Error(
					`beginPhaseRun: open phase run already exists for workflow ${input.workflowId} index ${input.phaseIndex}`,
				);
			}
			insertRelayChain(db, {
				chainId,
				collabId: workflow.collabId,
				maxRounds: input.maxRounds,
				now: input.now,
			});
			insertWorkflowPhaseRun(db, {
				phaseRunId,
				workflowId: input.workflowId,
				phaseIndex: input.phaseIndex,
				phaseName: input.phaseName,
				chainId,
				now: input.now,
			});
			insertWorkflowOwnedRelayHandoff(db, {
				handoffId,
				collabId: workflow.collabId,
				senderAgent: input.sender,
				targetAgent: input.target,
				requestText: input.kickoffText,
				chainId,
				roundNumber: 1,
				maxRounds: input.maxRounds,
				handoffStep: input.initialHandoffStep,
				workflowId: input.workflowId,
				phaseRunId,
				now: input.now,
			});
			if (input.executionBaseHeadSha) {
				updateWorkflowContext(db, {
					workflowId: input.workflowId,
					patch: { baseBeforeExecution: input.executionBaseHeadSha },
					now: input.now,
				});
			}
		});
		tx.immediate();

		const implementer = workflow.roleBindings.implementer;
		const reviewer = workflow.roleBindings.reviewer;

		events.emit("workflow.phase-started", {
			workflowId: input.workflowId,
			phaseIndex: input.phaseIndex,
			phaseName: input.phaseName,
			chainId,
			phaseRunId,
			implementer,
			reviewer,
		});
		events.emit("workflow.round-started", {
			workflowId: input.workflowId,
			chainId,
			phaseRunId,
			roundNumber: 1,
			handoffStep: input.initialHandoffStep,
			sender: input.sender,
			target: input.target,
		});

		return { phaseRunId, chainId, handoffId };
	}

	return {
		createWorkflow,
		getWorkflow,
		listWorkflows,
		getWorkflowPhaseRuns,
		getRelayChain,
		beginPhaseRun,
	};
}
