import type { BrokerRuntime } from "@ai-whisper/broker";

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
	const lines: string[] = [];

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
		lines.push(`${dot} ${p.name} ${stateLabel}`);
	}

	lines.push("");
	lines.push(`Collab: ${input.collabState}`);
	lines.push(`Threads: ${input.threadCount}`);
	if (input.activeThreadTitle) {
		lines.push(`Active: ${input.activeThreadTitle}`);
	}
	lines.push(`Uptime: ${input.uptime}`);
	if (input.lastRelayAge) {
		lines.push(`${GREEN}Last relay: ${input.lastRelayAge}${RESET}`);
	}
	lines.push(`Turn owner: ${input.turnOwner}`);
	if (input.waitingAgent) {
		lines.push(`Waiting: ${input.waitingAgent}`);
	}
	if (input.handoffState !== "idle") {
		lines.push(`Handoff: ${input.handoffState.replaceAll("_", " ")}`);
	}
	if (input.orchestratorEnabled) {
		lines.push(`Chain: ${input.chainStatus ?? "done"} (round ${input.currentRound ?? 0}/${input.maxRounds ?? 3})`);
	}

	return lines.join("\n");
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

	function renderTurnPanel() {
		const turn = input.broker.control.getRelayTurnState(
			input.collabId,
			new Date().toISOString(),
		);
		const turnStateKey = `${turn.turnOwner}|${turn.waitingAgent ?? ""}|${turn.handoffState}`;
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
