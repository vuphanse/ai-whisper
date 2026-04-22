import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import { getCollab } from "../storage/repositories/collab-repository.js";
import { listSessionBindingsForCollab } from "../storage/repositories/session-binding-repository.js";
import {
	insertWorkflow,
	getWorkflowById,
	listWorkflows as listWorkflowsRepo,
	countRunningWorkflowsForCollab,
	type WorkflowRecord,
	type WorkflowStatus,
} from "../storage/repositories/workflow-repository.js";
import {
	listPhaseRunsForWorkflow,
	type WorkflowPhaseRunRecord,
} from "../storage/repositories/workflow-phase-repository.js";
import {
	getRelayChain as getRelayChainRepo,
	type RelayChainRecord,
} from "../storage/repositories/relay-chain-repository.js";
import {
	getWorkflowDefinition,
	listWorkflowTypes,
} from "../runtime/workflow-registry.js";
import type { BrokerEventBus } from "../runtime/broker-event-bus.js";

export interface WorkflowControlDeps {
	db: Database.Database;
	events: BrokerEventBus;
}

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

	return {
		createWorkflow,
		getWorkflow,
		listWorkflows,
		getWorkflowPhaseRuns,
		getRelayChain,
	};
}
