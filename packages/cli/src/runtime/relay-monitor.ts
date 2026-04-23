import type { BrokerRuntime } from "@ai-whisper/broker";
import { getWorkflowDefinition } from "../../../broker/src/runtime/workflow-registry.js";

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const ORANGE = "\u001b[38;5;215m";
const BLUE = "\u001b[38;5;75m";
const GREEN = "\u001b[38;5;114m";
const RED = "\u001b[38;5;203m";
const GRAY = "\u001b[38;5;244m";
const SAVE_CURSOR = "\u001b7";
const RESTORE_CURSOR = "\u001b8";
const CLEAR_LINE = "\r\u001b[2K";

export interface RelayEventItem {
	id: number;
	eventType: string;
	senderAgent: string | null;
	receiverAgent: string | null;
	content: string;
	createdAt: string;
}

function extractTime(isoTimestamp: string): string {
	const date = new Date(isoTimestamp);
	return [
		String(date.getUTCHours()).padStart(2, "0"),
		String(date.getUTCMinutes()).padStart(2, "0"),
		String(date.getUTCSeconds()).padStart(2, "0"),
	].join(":");
}

function agentColor(agent: string): string {
	return agent === "claude" ? BLUE : ORANGE;
}

export function formatRelayConversationLine(input: {
	eventType: string;
	senderAgent: string | null;
	receiverAgent: string | null;
	content: string;
	createdAt: string;
	isLatest: boolean;
}): string {
	const time = extractTime(input.createdAt);
	const latestBadge = input.isLatest ? ` ${ORANGE}${BOLD}LATEST${RESET}` : "";

	if (input.eventType === "status") {
		return `${GRAY}${DIM}${time}  ${input.content}${RESET}`;
	}

	if (input.eventType === "cancellation") {
		return `${DIM}${time}${RESET}  ${RED}[${input.senderAgent}] relay work cancelled by user${RESET}${latestBadge}`;
	}

	const sender = input.senderAgent ?? "?";
	const receiver = input.receiverAgent ?? "?";
	const header = `${DIM}${time}${RESET}  ${agentColor(sender)}[${sender}]${RESET} ${DIM}→${RESET} ${agentColor(receiver)}[${receiver}]${RESET}:${latestBadge}`;

	const bodyLines = input.content
		.split("\n")
		.map((line) => `  ${line}`)
		.join("\n");

	return `${header}\n${bodyLines}`;
}

function countRenderedLines(text: string): number {
	return text.split("\n").length;
}

export function formatLatestBadgeClearSequence(event: RelayEventItem): string {
	const rendered = formatRelayConversationLine({
		eventType: event.eventType,
		senderAgent: event.senderAgent,
		receiverAgent: event.receiverAgent,
		content: event.content,
		createdAt: event.createdAt,
		isLatest: false,
	});
	const header = rendered.split("\n")[0] ?? "";
	const lines = countRenderedLines(rendered);
	return `${SAVE_CURSOR}\u001b[${lines}A${CLEAR_LINE}${header}${RESTORE_CURSOR}`;
}

export function renderRelayConversationBatch(input: {
	previousLatestEvent: RelayEventItem | null;
	events: RelayEventItem[];
}): string {
	let output = "";

	if (input.previousLatestEvent && input.events.length > 0) {
		output += formatLatestBadgeClearSequence(input.previousLatestEvent);
	}

	const renderedEvents: string[] = [];

	for (let i = 0; i < input.events.length; i++) {
		const event = input.events[i]!;
		const isLatest = i === input.events.length - 1;
		renderedEvents.push(formatRelayConversationLine({
			eventType: event.eventType,
			senderAgent: event.senderAgent,
			receiverAgent: event.receiverAgent,
			content: event.content,
			createdAt: event.createdAt,
			isLatest,
		}));
	}

	output += `${renderedEvents.join("\n")}\n`;

	return output;
}

export function formatStatusPanel(input: {
	providers: Array<{ name: string; health: string }>;
	collabState: string;
	threadCount: number;
	activeThreadTitle: string | null;
	uptime: string;
	lastRelayAge: string | null;
	turnOwner: "codex" | "claude" | "none";
	waitingAgent: "codex" | "claude" | null;
	handoffState: "idle" | "pending" | "deferred" | "accepted" | "stale_handoff" | "failed";
	orchestratorEnabled?: boolean;
	currentRound?: number;
	maxRounds?: number;
	chainStatus?: "active" | "done" | "escalated" | "abandoned";
}): string {
	const segments: string[] = [];

	for (const p of input.providers) {
		const dot =
			p.health === "online"
				? `${GREEN}●${RESET}`
				: p.health === "relay_work"
					? `${ORANGE}◉${RESET}`
					: `${RED}●${RESET}`;
		const stateLabel =
			p.health === "online"
				? `${DIM}online${RESET}`
				: p.health === "relay_work"
					? `${ORANGE}relay work${RESET}`
					: `${RED}${p.health}${RESET}`;
		segments.push(`${dot} ${p.name} ${stateLabel}`);
	}

	segments.push(`Collab: ${input.collabState}`);
	segments.push(`Threads: ${input.threadCount}`);
	if (input.activeThreadTitle) {
		segments.push(`Active: ${input.activeThreadTitle}`);
	}
	if (input.uptime) {
		segments.push(`Uptime: ${input.uptime}`);
	}
	if (input.lastRelayAge) {
		segments.push(`${GREEN}Last relay: ${input.lastRelayAge}${RESET}`);
	}
	segments.push(`Turn owner: ${input.turnOwner}`);
	if (input.waitingAgent) {
		segments.push(`Waiting: ${input.waitingAgent}`);
	}
	if (input.handoffState !== "idle") {
		segments.push(`Handoff: ${input.handoffState.replaceAll("_", " ")}`);
	}
	if (input.orchestratorEnabled) {
		segments.push(`Chain: ${input.chainStatus ?? "done"} (round ${input.currentRound ?? 0}/${input.maxRounds ?? 3})`);
	}

	return segments.join(" - ");
}

export function createRelayMonitorRuntime(input: {
	broker: BrokerRuntime;
	collabId: string;
	monitorId: string;
	stdout: NodeJS.WritableStream;
	pollIntervalMs?: number;
}) {
	let cursor = 0;
	let stopping = false;
	let previousLatestEvent: RelayEventItem | null = null;
	let previousTurnStateKey: string | null = null;
	let lastRenderedPhaseRunId: string | null = null;
	let lastRenderedRound: number | null = null;
	let lastRenderedWorkflowStatus: string | null = null;
	let loopResolve!: () => void;
	const loopDone = new Promise<void>((r) => {
		loopResolve = r;
	});

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function render(events: RelayEventItem[]) {
		if (events.length === 0) {
			return;
		}

		input.stdout.write(
			renderRelayConversationBatch({
				previousLatestEvent,
				events,
			}),
		);
		previousLatestEvent = events[events.length - 1] ?? previousLatestEvent;
	}

	function renderWorkflowPanel() {
		// listWorkflows is part of workflowControl — only present when broker has workflow support
		if (typeof input.broker.control.listWorkflows !== "function") {
			return;
		}
		const runningWorkflows = input.broker.control.listWorkflows({
			collabId: input.collabId,
			status: "running",
		});
		const workflow = runningWorkflows[0] ?? null;

		// Detect terminal transitions (done / halted / canceled)
		if (!workflow) {
			if (lastRenderedWorkflowStatus === "running") {
				// Workflow just transitioned out of running — check last known status
				// by seeing if listWorkflows with no status filter has a terminal record
				const allWorkflows = input.broker.control.listWorkflows({
					collabId: input.collabId,
				});
				const latestTerminal = allWorkflows[allWorkflows.length - 1] ?? null;
				if (latestTerminal?.status === "done") {
					input.stdout.write(`✔ workflow-done: ${latestTerminal.workflowId}\n`);
				} else if (latestTerminal?.status === "halted" || latestTerminal?.status === "canceled") {
					input.stdout.write(`✖ workflow-${latestTerminal.status}: ${latestTerminal.workflowId}\n`);
				}
			}
			lastRenderedWorkflowStatus = null;
			lastRenderedPhaseRunId = null;
			lastRenderedRound = null;
			return;
		}

		lastRenderedWorkflowStatus = "running";

		// Get current phase run
		const phaseRuns = input.broker.control.getWorkflowPhaseRuns(workflow.workflowId);
		const currentPhaseRun = phaseRuns.find((r) => r.endedAt === null) ?? null;

		if (!currentPhaseRun) {
			return;
		}

		// Get chain for round info
		const chain = input.broker.control.getRelayChain(currentPhaseRun.chainId);

		// Detect phase transitions
		if (lastRenderedPhaseRunId !== currentPhaseRun.phaseRunId) {
			input.stdout.write(`▶ phase-started: ${currentPhaseRun.phaseName}\n`);
			lastRenderedPhaseRunId = currentPhaseRun.phaseRunId;
			lastRenderedRound = chain?.currentRound ?? null;
		} else if (chain && chain.currentRound >= 2 && lastRenderedRound !== chain.currentRound) {
			// Round transition within same phase
			input.stdout.write(`↻ round-started: round ${chain.currentRound}/${chain.maxRounds}\n`);
			lastRenderedRound = chain.currentRound;
		}

		// Get full workflow record (required per spec)
		const fullWorkflow = input.broker.control.getWorkflow(workflow.workflowId);

		// Resolve totalPhases from workflow registry
		const workflowDef = getWorkflowDefinition(workflow.workflowType);
		const totalPhases = workflowDef ? workflowDef.phases.length : "?";

		// Get handoff step from the latest handoff for this phase run
		const latestHandoffRow = (input.broker.db as import("better-sqlite3").Database)
			.prepare(
				`SELECT handoff_step FROM relay_handoff
				 WHERE phase_run_id = ?
				 ORDER BY created_at DESC LIMIT 1`,
			)
			.get(currentPhaseRun.phaseRunId) as { handoff_step: string | null } | undefined;
		const handoffStep = latestHandoffRow?.handoff_step ?? "-";

		// Render header block
		const phaseLabel = currentPhaseRun.phaseName;
		const phaseNum = currentPhaseRun.phaseIndex + 1;
		const currentRound = chain?.currentRound ?? 1;
		const maxRounds = chain?.maxRounds ?? 3;
		const workflowLabel = (fullWorkflow?.name ?? workflow.name) ?? workflow.workflowType;

		const headerLine1 = `Workflow: ${workflow.workflowId} (${workflow.workflowType}) "${workflowLabel}"`;
		const headerLine2 = `Phase:    ${phaseLabel} (${phaseNum}/${totalPhases})   Round: ${currentRound}/${maxRounds}   Step: ${handoffStep}   Chain: ${currentPhaseRun.chainId}`;

		input.stdout.write(`${headerLine1}\n${headerLine2}\n`);
	}

	function renderTurnPanel() {
		const turn = input.broker.control.getRelayTurnState(
			input.collabId,
			new Date().toISOString(),
		);
		const orchestratorSuffix = turn.orchestratorEnabled
			? `|${turn.chainStatus}|${turn.currentRound}`
			: "";
		const turnStateKey = `${turn.turnOwner}|${turn.waitingAgent ?? ""}|${turn.handoffState}${orchestratorSuffix}`;
		if (turnStateKey === previousTurnStateKey) {
			return;
		}
		previousTurnStateKey = turnStateKey;

		const sessions = input.broker.control.listSessions(input.collabId);
		const threads = input.broker.control.listThreads(input.collabId);
		const activeThread = threads.find((t) => t.active) ?? null;

		const providers = (["codex", "claude"] as const).map((agentType) => {
			const session = sessions.find((s) => s.agentType === agentType);
			const rawHealth = session?.healthState ?? "offline";
			const health = rawHealth === "healthy" ? "online" : rawHealth;
			return { name: agentType, health };
		});

		const panel = formatStatusPanel({
			providers,
			collabState: "active",
			threadCount: threads.length,
			activeThreadTitle: activeThread?.title ?? null,
			uptime: "",
			lastRelayAge: null,
			turnOwner: turn.turnOwner,
			waitingAgent: turn.waitingAgent,
			handoffState: turn.handoffState,
			orchestratorEnabled: turn.orchestratorEnabled,
			currentRound: turn.currentRound,
			maxRounds: turn.maxRounds,
			chainStatus: turn.chainStatus,
		});

		input.stdout.write(`\n${panel}\n`);
	}

	return {
		start() {
			input.broker.control.registerRelayMonitor({
				collabId: input.collabId,
				monitorId: input.monitorId,
				now: new Date().toISOString(),
			});

			void (async () => {
				while (!stopping) {
					input.broker.control.heartbeatRelayMonitor({
						collabId: input.collabId,
						monitorId: input.monitorId,
						now: new Date().toISOString(),
					});

					const events = input.broker.control.pollRelayEvents(
						input.collabId,
						cursor,
					);

					if (events.length > 0) {
						cursor = events[events.length - 1]!.id;
						render(events);
					}

					renderWorkflowPanel();
					renderTurnPanel();

					await sleep(input.pollIntervalMs ?? 250);
				}
				loopResolve();
			})();
		},

		async stop() {
			stopping = true;
			await loopDone;
		},

		waitUntilStopped() {
			return loopDone;
		},
	};
}
