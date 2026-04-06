import type { BrokerRuntime } from "@ai-whisper/broker";

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const BOLD = "\u001b[1m";
const ORANGE = "\u001b[38;5;215m";
const BLUE = "\u001b[38;5;75m";
const GREEN = "\u001b[38;5;114m";
const RED = "\u001b[38;5;203m";

interface RelayEventItem {
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
		return `${DIM}${time}  ${input.content}${RESET}`;
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

export function formatStatusPanel(input: {
	providers: Array<{ name: string; health: string }>;
	collabState: string;
	threadCount: number;
	activeThreadTitle: string | null;
	uptime: string;
	lastRelayAge: string | null;
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
	let loopResolve!: () => void;
	const loopDone = new Promise<void>((r) => {
		loopResolve = r;
	});

	function sleep(ms: number): Promise<void> {
		return new Promise((resolve) => setTimeout(resolve, ms));
	}

	function render(events: RelayEventItem[]) {
		for (let i = 0; i < events.length; i++) {
			const event = events[i];
			const isLatest = i === events.length - 1;
			const line = formatRelayConversationLine({
				eventType: event.eventType,
				senderAgent: event.senderAgent,
				receiverAgent: event.receiverAgent,
				content: event.content,
				createdAt: event.createdAt,
				isLatest,
			});
			input.stdout.write(`${line}\n\n`);
		}
	}

	return {
		async start() {
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
						cursor = events[events.length - 1].id;
						render(events);
					}

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
