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
	setWorkflowStatus,
	incrementCurrentPhaseIndex,
	type WorkflowRecord,
	type WorkflowStatus,
} from "../storage/repositories/workflow-repository.js";
import {
	insertWorkflowPhaseRun,
	listPhaseRunsForWorkflow,
	hasOpenPhaseRunForIndex,
	closeWorkflowPhaseRun,
	type WorkflowPhaseRunRecord,
} from "../storage/repositories/workflow-phase-repository.js";
import {
	insertRelayChain,
	getRelayChain as getRelayChainRepo,
	setChainTerminal,
	incrementChainRound,
	type RelayChainRecord,
} from "../storage/repositories/relay-chain-repository.js";
import {
	insertWorkflowOwnedRelayHandoff,
	getHandoffWithWorkflowMetaById,
	updateEvaluatorBookkeeping,
	structuredVerdictToLegacy,
} from "../storage/repositories/relay-handoff-repository.js";
import { upsertRelayTurnState } from "../storage/repositories/relay-turn-state-repository.js";
import {
	getWorkflowDefinition,
	listWorkflowTypes,
	renderTemplate,
	derivePlanPath,
	type PhaseConfig,
	type WorkflowDefinition,
} from "../runtime/workflow-registry.js";
import type {
	BrokerEventBus,
	BrokerEventName,
} from "../runtime/broker-event-bus.js";

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

	type NormalizedVerdict =
		| "approve"
		| "findings"
		| "delivered"
		| "execution-pass"
		| "execution-fail"
		| "escalate";

	function normalizeVerdict(input: {
		step: "review" | "fix" | "implement" | "execute";
		verdict: NormalizedVerdict;
		confidence: number;
		currentRound: number;
		maxRounds: number;
		originalReason: string;
	}): { verdict: NormalizedVerdict; reason: string } {
		if (input.confidence < 0.5) {
			return {
				verdict: "escalate",
				reason: `low-confidence: ${input.originalReason}`,
			};
		}
		const allowed = {
			review: ["approve", "findings", "escalate"],
			fix: ["delivered", "escalate"],
			implement: ["delivered", "escalate"],
			execute: ["execution-pass", "execution-fail", "escalate"],
		} as const;
		if (!allowed[input.step].includes(input.verdict as never)) {
			return {
				verdict: "escalate",
				reason: `illegal-step-verdict: ${input.verdict}`,
			};
		}
		if (
			input.step === "review" &&
			input.verdict === "findings" &&
			input.currentRound + 1 > input.maxRounds
		) {
			return {
				verdict: "escalate",
				reason: `max-rounds-reached (${input.currentRound}/${input.maxRounds})`,
			};
		}
		return { verdict: input.verdict, reason: input.originalReason };
	}

	function getAgentForRole(
		workflow: WorkflowRecord,
		role: "implementer" | "reviewer",
	): "claude" | "codex" {
		const v = workflow.roleBindings[role];
		if (!v) throw new Error(`getAgentForRole: no binding for ${role}`);
		return v;
	}

	/**
	 * derivePlanPath() throws on specPath not ending in "-design.md". At the
	 * applyOrchestratorVerdict layer we still need to render templates that
	 * reference {planPath} even when the caller supplied a looser spec path
	 * (e.g. during tests or early smoke scripts). Fall back to using the
	 * specPath itself as a placeholder so template rendering succeeds rather
	 * than aborting an otherwise-valid state transition. The CLI workflow
	 * create command is responsible for enforcing the convention upstream.
	 */
	function safeDerivePlanPath(specPath: string, createdAt: string): string {
		try {
			return derivePlanPath(specPath, createdAt);
		} catch {
			return specPath;
		}
	}

	function renderReviewRequestText(input: {
		workflow: WorkflowRecord;
		phase: PhaseConfig;
	}): string {
		const ctx = input.workflow.workflowContext as { commitRange?: string };
		const tmpl = input.phase.stepTemplates.review ?? "Review the deliverable.";
		return renderTemplate(tmpl, {
			specPath: input.workflow.specPath,
			planPath: safeDerivePlanPath(
				input.workflow.specPath,
				input.workflow.createdAt,
			),
			commitRange: ctx.commitRange ?? "HEAD",
		});
	}

	function createContinuationHandoff(input: {
		workflow: WorkflowRecord;
		chain: RelayChainRecord;
		prev: NonNullable<ReturnType<typeof getHandoffWithWorkflowMetaById>>;
		nextStep: "review" | "fix";
		sender: "claude" | "codex";
		target: "claude" | "codex";
		requestText: string;
		incrementRound: boolean;
		now: string;
	}): string {
		const handoffId = `ho_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		insertWorkflowOwnedRelayHandoff(db, {
			handoffId,
			collabId: input.workflow.collabId,
			senderAgent: input.sender,
			targetAgent: input.target,
			requestText: input.requestText,
			chainId: input.chain.chainId,
			roundNumber: input.incrementRound
				? input.chain.currentRound + 1
				: input.chain.currentRound,
			maxRounds: input.chain.maxRounds,
			handoffStep: input.nextStep,
			workflowId: input.workflow.workflowId,
			phaseRunId: input.prev.phaseRunId!,
			now: input.now,
		});
		if (input.incrementRound) {
			incrementChainRound(db, {
				chainId: input.chain.chainId,
				now: input.now,
			});
		}
		return handoffId;
	}

	function kickoffNextPhaseInternal(input: {
		workflow: WorkflowRecord;
		definition: WorkflowDefinition;
		workspaceHeadSha: string | undefined;
		now: string;
		pendingEmissions: Array<{ name: BrokerEventName; payload: unknown }>;
	}): { phaseRunId: string; chainId: string; handoffId: string } {
		const phase = input.definition.phases[input.workflow.currentPhaseIndex];
		const sender =
			phase.initialHandoffStep === "review"
				? getAgentForRole(input.workflow, "implementer")
				: getAgentForRole(input.workflow, "reviewer");
		const target =
			phase.initialHandoffStep === "review"
				? getAgentForRole(input.workflow, "reviewer")
				: getAgentForRole(input.workflow, "implementer");
		const ctx = input.workflow.workflowContext as { commitRange?: string };
		const kickoffText = renderTemplate(phase.kickoffTemplate, {
			specPath: input.workflow.specPath,
			planPath: safeDerivePlanPath(
				input.workflow.specPath,
				input.workflow.createdAt,
			),
			commitRange: ctx.commitRange ?? "HEAD",
		});
		const chainId = `relay_ch_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const phaseRunId = `wfp_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		const handoffId = `ho_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
		insertRelayChain(db, {
			chainId,
			collabId: input.workflow.collabId,
			maxRounds: phase.maxRounds,
			now: input.now,
		});
		insertWorkflowPhaseRun(db, {
			phaseRunId,
			workflowId: input.workflow.workflowId,
			phaseIndex: input.workflow.currentPhaseIndex,
			phaseName: phase.name,
			chainId,
			now: input.now,
		});
		insertWorkflowOwnedRelayHandoff(db, {
			handoffId,
			collabId: input.workflow.collabId,
			senderAgent: sender,
			targetAgent: target,
			requestText: kickoffText,
			chainId,
			roundNumber: 1,
			maxRounds: phase.maxRounds,
			handoffStep: phase.initialHandoffStep,
			workflowId: input.workflow.workflowId,
			phaseRunId,
			now: input.now,
		});
		if (phase.initialHandoffStep === "execute") {
			if (!input.workspaceHeadSha) {
				throw new Error(
					"kickoffNextPhaseInternal: workspaceHeadSha required for execute phase",
				);
			}
			updateWorkflowContext(db, {
				workflowId: input.workflow.workflowId,
				patch: { baseBeforeExecution: input.workspaceHeadSha },
				now: input.now,
			});
		}
		input.pendingEmissions.push({
			name: "workflow.phase-started",
			payload: {
				workflowId: input.workflow.workflowId,
				phaseIndex: input.workflow.currentPhaseIndex,
				phaseName: phase.name,
				chainId,
				phaseRunId,
				implementer: getAgentForRole(input.workflow, "implementer"),
				reviewer: getAgentForRole(input.workflow, "reviewer"),
			},
		});
		input.pendingEmissions.push({
			name: "workflow.round-started",
			payload: {
				workflowId: input.workflow.workflowId,
				chainId,
				phaseRunId,
				roundNumber: 1,
				handoffStep: phase.initialHandoffStep,
				sender,
				target,
			},
		});
		return { phaseRunId, chainId, handoffId };
	}

	function applyOrchestratorVerdict(input: {
		handoffId: string;
		verdict: NormalizedVerdict;
		confidence: number;
		reason: string;
		followUpMessage?: string;
		extractedCommitShas?: string[];
		workspaceHeadSha?: string;
		now: string;
	}): {
		action:
			| "chain-continued"
			| "phase-advanced"
			| "workflow-done"
			| "workflow-halted"
			| "noop-already-applied";
		chainId: string;
		nextHandoffId?: string;
		nextPhaseRunId?: string;
	} {
		const handoff = getHandoffWithWorkflowMetaById(db, input.handoffId);
		if (!handoff || !handoff.workflowId || !handoff.handoffStep) {
			throw new Error(
				"applyOrchestratorVerdict: handoff is not workflow-owned",
			);
		}
		if (handoff.evaluatorVerdict) {
			return {
				action: "noop-already-applied",
				chainId: handoff.chainId ?? "",
			};
		}
		const workflow = getWorkflowById(db, handoff.workflowId);
		if (!workflow || workflow.status !== "running") {
			throw new Error("applyOrchestratorVerdict: workflow not running");
		}
		const chain = getRelayChainRepo(db, handoff.chainId!);
		if (!chain || chain.status !== "active") {
			throw new Error("applyOrchestratorVerdict: chain not active");
		}

		const definition = getWorkflowDefinition(workflow.workflowType)!;
		const phase = definition.phases[workflow.currentPhaseIndex];
		const nextPhase = definition.phases[workflow.currentPhaseIndex + 1];

		const normalized = normalizeVerdict({
			step: handoff.handoffStep,
			verdict: input.verdict,
			confidence: input.confidence,
			currentRound: chain.currentRound,
			maxRounds: chain.maxRounds,
			originalReason: input.reason,
		});

		// Enforce workspaceHeadSha for advance-into-execute
		if (
			normalized.verdict === "approve" &&
			handoff.handoffStep === "review" &&
			nextPhase?.initialHandoffStep === "execute" &&
			(!input.workspaceHeadSha || !SHA_REGEX.test(input.workspaceHeadSha))
		) {
			throw new Error(
				"applyOrchestratorVerdict: workspaceHeadSha required for advance into plan-execution",
			);
		}

		let action:
			| "chain-continued"
			| "phase-advanced"
			| "workflow-done"
			| "workflow-halted"
			| "noop-already-applied" = "chain-continued";
		let nextHandoffId: string | undefined;
		let nextPhaseRunId: string | undefined;

		const pendingEmissions: Array<{
			name: BrokerEventName;
			payload: unknown;
		}> = [];

		const tx = db.transaction(() => {
			updateEvaluatorBookkeeping(db, {
				handoffId: input.handoffId,
				evaluatorVerdict: normalized.verdict,
				evaluatorConfidence: input.confidence,
				evaluatorReason: normalized.reason,
				evaluatorEvaluatedAt: input.now,
				legacyVerdict: structuredVerdictToLegacy(normalized.verdict),
			});

			if (
				normalized.verdict === "approve" ||
				normalized.verdict === "execution-pass"
			) {
				setChainTerminal(db, {
					chainId: chain.chainId,
					status: "done",
					terminalHandoffId: input.handoffId,
					terminalReason: normalized.reason,
					now: input.now,
				});
				closeWorkflowPhaseRun(db, {
					phaseRunId: handoff.phaseRunId!,
					outcome: "done",
					now: input.now,
				});

				if (normalized.verdict === "execution-pass") {
					const shas = (input.extractedCommitShas ?? []).filter((s) =>
						SHA_REGEX.test(s),
					);
					if (shas.length > 0) {
						const base =
							(
								workflow.workflowContext as {
									baseBeforeExecution?: string;
								}
							).baseBeforeExecution ?? "";
						const head = shas[shas.length - 1];
						updateWorkflowContext(db, {
							workflowId: workflow.workflowId,
							patch: {
								executionCommitShas: shas,
								headAfterExecution: head,
								commitRange: `${base}..${head}`,
							},
							now: input.now,
						});
					}
				}

				if (!nextPhase) {
					setWorkflowStatus(db, {
						workflowId: workflow.workflowId,
						status: "done",
						haltReason: null,
						now: input.now,
					});
					upsertRelayTurnState(db, {
						collabId: workflow.collabId,
						turnOwner: "none",
						waitingAgent: null,
						unresolvedHandoffId: null,
						handoffState: "idle",
						updatedAt: input.now,
						orchestratorEnabled: true,
						currentRound: chain.currentRound,
						maxRounds: chain.maxRounds,
						chainStatus: "done",
					});
					action = "workflow-done";
				} else {
					incrementCurrentPhaseIndex(db, {
						workflowId: workflow.workflowId,
						now: input.now,
					});
					const kickoff = kickoffNextPhaseInternal({
						workflow: {
							...workflow,
							currentPhaseIndex: workflow.currentPhaseIndex + 1,
						},
						definition,
						workspaceHeadSha: input.workspaceHeadSha,
						now: input.now,
						pendingEmissions,
					});
					nextHandoffId = kickoff.handoffId;
					nextPhaseRunId = kickoff.phaseRunId;
					action = "phase-advanced";
				}
			} else if (normalized.verdict === "findings") {
				nextHandoffId = createContinuationHandoff({
					workflow,
					chain,
					prev: handoff,
					nextStep: "fix",
					sender: getAgentForRole(workflow, "reviewer"),
					target: getAgentForRole(workflow, "implementer"),
					requestText:
						input.followUpMessage ?? "Address reviewer findings.",
					incrementRound: false,
					now: input.now,
				});
				action = "chain-continued";
			} else if (normalized.verdict === "delivered") {
				const sender = getAgentForRole(workflow, "implementer");
				const target = getAgentForRole(workflow, "reviewer");

				if (phase.name === "code-review" && handoff.handoffStep === "fix") {
					const shas = (input.extractedCommitShas ?? []).filter((s) =>
						SHA_REGEX.test(s),
					);
					if (shas.length > 0) {
						const ctx = workflow.workflowContext as {
							baseBeforeExecution?: string;
							codeReviewFixShas?: string[];
						};
						const base = ctx.baseBeforeExecution ?? "";
						const head = shas[shas.length - 1];
						updateWorkflowContext(db, {
							workflowId: workflow.workflowId,
							patch: {
								codeReviewFixShas: [
									...(ctx.codeReviewFixShas ?? []),
									...shas,
								],
								headAfterExecution: head,
								commitRange: `${base}..${head}`,
							},
							now: input.now,
						});
					}
				}

				nextHandoffId = createContinuationHandoff({
					workflow,
					chain,
					prev: handoff,
					nextStep: "review",
					sender,
					target,
					requestText: renderReviewRequestText({ workflow, phase }),
					incrementRound: true,
					now: input.now,
				});
				action = "chain-continued";
			} else {
				// escalate OR execution-fail
				setChainTerminal(db, {
					chainId: chain.chainId,
					status: "escalated",
					terminalHandoffId: input.handoffId,
					terminalReason: normalized.reason,
					now: input.now,
				});
				closeWorkflowPhaseRun(db, {
					phaseRunId: handoff.phaseRunId!,
					outcome: "escalated",
					now: input.now,
				});
				setWorkflowStatus(db, {
					workflowId: workflow.workflowId,
					status: "halted",
					haltReason: normalized.reason,
					now: input.now,
				});
				upsertRelayTurnState(db, {
					collabId: workflow.collabId,
					turnOwner: "none",
					waitingAgent: null,
					unresolvedHandoffId: null,
					handoffState: "idle",
					updatedAt: input.now,
					orchestratorEnabled: true,
					currentRound: chain.currentRound,
					maxRounds: chain.maxRounds,
					chainStatus: "escalated",
				});
				action = "workflow-halted";
			}

			// Buffer event sequence inside tx; drain after commit.
			if (action === "chain-continued") {
				pendingEmissions.push({
					name: "workflow.round-started",
					payload: {
						workflowId: workflow.workflowId,
						chainId: chain.chainId,
						phaseRunId: handoff.phaseRunId!,
						roundNumber:
							normalized.verdict === "findings"
								? chain.currentRound
								: chain.currentRound + 1,
						handoffStep:
							normalized.verdict === "findings" ? "fix" : "review",
						sender: getAgentForRole(
							workflow,
							normalized.verdict === "findings"
								? "reviewer"
								: "implementer",
						),
						target: getAgentForRole(
							workflow,
							normalized.verdict === "findings"
								? "implementer"
								: "reviewer",
						),
					},
				});
			} else if (action === "phase-advanced") {
				pendingEmissions.unshift({
					name: "chain.resolved",
					payload: {
						collabId: workflow.collabId,
						chainId: chain.chainId,
					},
				});
				pendingEmissions.splice(1, 0, {
					name: "workflow.phase-done",
					payload: {
						workflowId: workflow.workflowId,
						phaseIndex: workflow.currentPhaseIndex,
						phaseName: phase.name,
					},
				});
			} else if (action === "workflow-done") {
				pendingEmissions.push(
					{
						name: "chain.resolved",
						payload: {
							collabId: workflow.collabId,
							chainId: chain.chainId,
						},
					},
					{
						name: "workflow.phase-done",
						payload: {
							workflowId: workflow.workflowId,
							phaseIndex: workflow.currentPhaseIndex,
							phaseName: phase.name,
						},
					},
					{
						name: "workflow.done",
						payload: { workflowId: workflow.workflowId },
					},
				);
			} else if (action === "workflow-halted") {
				pendingEmissions.push(
					{
						name: "chain.escalated",
						payload: {
							collabId: workflow.collabId,
							chainId: chain.chainId,
							handoffId: input.handoffId,
							reason: normalized.reason,
						},
					},
					{
						name: "workflow.phase-done",
						payload: {
							workflowId: workflow.workflowId,
							phaseIndex: workflow.currentPhaseIndex,
							phaseName: phase.name,
						},
					},
					{
						name: "workflow.halted",
						payload: {
							workflowId: workflow.workflowId,
							reason: normalized.reason,
						},
					},
				);
			}
		});
		tx.immediate();

		// Drain emissions strictly after COMMIT.
		for (const { name, payload } of pendingEmissions) {
			events.emit(name as never, payload as never);
		}

		const result: {
			action: typeof action;
			chainId: string;
			nextHandoffId?: string;
			nextPhaseRunId?: string;
		} = { action, chainId: chain.chainId };
		if (nextHandoffId) result.nextHandoffId = nextHandoffId;
		if (nextPhaseRunId) result.nextPhaseRunId = nextPhaseRunId;
		return result;
	}

	return {
		createWorkflow,
		getWorkflow,
		listWorkflows,
		getWorkflowPhaseRuns,
		getRelayChain,
		beginPhaseRun,
		applyOrchestratorVerdict,
	};
}
