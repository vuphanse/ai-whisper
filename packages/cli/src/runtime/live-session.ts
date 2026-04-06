import type {
	InteractiveSessionController,
	RelayDirective,
} from "@ai-whisper/shared";
import { appendFileSync } from "node:fs";
import {
	getRelayDirectiveError,
	parseRelayDirective,
} from "./relay-directive.js";
import { createRelayLineBuffer } from "./relay-line-buffer.js";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ORANGE_RELAY = "\u001b[38;5;215m";
const ANSI_RESET = "\u001b[0m";
const CLEAR_LINE = "\r\u001b[2K";
const terminalResponsePatterns = [
	new RegExp(`${ESC}\\[[0-9;]*R`, "g"),
	new RegExp(`${ESC}\\[[?>0-9;]*c`, "g"),
	new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"),
];

function stripTerminalResponses(raw: string): string {
	return terminalResponsePatterns.reduce(
		(text, pattern) => text.replace(pattern, ""),
		raw,
	);
}

function toHex(text: string): string {
	return Buffer.from(text, "utf8").toString("hex");
}

export function createLiveSessionRuntime(input: {
	interactiveSession: InteractiveSessionController;
	stdin: NodeJS.ReadableStream;
	stdout: NodeJS.WritableStream;
	onRelay: (
		directive: RelayDirective,
		sendNow: (message: string) => void,
	) => Promise<string | null>;
}) {
	const ttyStdin = input.stdin as NodeJS.ReadableStream & {
		isTTY?: boolean;
		isRaw?: boolean;
		setRawMode?: (mode: boolean) => void;
	};
	const previousRawMode = ttyStdin.isRaw;
	const debugLogPath = process.env.AI_WHISPER_DEBUG_INPUT_LOG;
	const lineBuffer = createRelayLineBuffer({
		getError: getRelayDirectiveError,
		isRelayDirective: (line) => parseRelayDirective(line) !== null,
		isRelayPrefix: (line) =>
			["@@codex", "@@claude"].some(
				(target) => target.startsWith(line) || line.startsWith(target),
			),
	});
	let relayPreviewVisible = false;

	function debug(event: Record<string, unknown>) {
		if (!debugLogPath) {
			return;
		}

		appendFileSync(
			debugLogPath,
			`${JSON.stringify({
				at: new Date().toISOString(),
				sessionId: process.env.AI_WHISPER_SESSION_ID ?? null,
				...event,
			})}\n`,
		);
	}

	function renderRelayPreview(line: string) {
		if (!line.startsWith("@@")) {
			clearRelayPreview();
			return;
		}

		relayPreviewVisible = true;
		input.interactiveSession.sendLocalMessage(
			`${CLEAR_LINE}${ORANGE_RELAY}${line}${ANSI_RESET}`,
		);
	}

	function clearRelayPreview() {
		if (!relayPreviewVisible) {
			return;
		}

		relayPreviewVisible = false;
		input.interactiveSession.sendLocalMessage(CLEAR_LINE);
	}

	async function processChunk(raw: string) {
		const sanitized = stripTerminalResponses(raw);
		debug({
			type: "chunk",
			raw,
			rawHex: toHex(raw),
			sanitized,
			sanitizedHex: toHex(sanitized),
		});
		if (sanitized.length === 0) {
			return;
		}

		for (const decision of lineBuffer.push(sanitized)) {
			debug({
				type: "decision",
				decision,
			});
			if (decision.kind === "buffering") {
				renderRelayPreview(decision.line);
				continue;
			}

			clearRelayPreview();
			if (decision.kind === "passthrough") {
				input.interactiveSession.writeUserInput(decision.data);
				continue;
			}
			if (decision.kind === "error") {
				input.interactiveSession.sendLocalMessage(
					`${decision.message}\n`,
				);
				continue;
			}
			if (decision.kind === "relay") {
				await handleLine(decision.line);
			}
		}
	}

	async function handleLine(line: string) {
		const directive = parseRelayDirective(line);
		debug({
			type: "handle-line",
			line,
			directive,
		});
		if (!directive) {
			return;
		}

		try {
			const message = await input.onRelay(
				directive,
				(msg) => input.interactiveSession.sendLocalMessage(msg),
			);
			if (message) {
				input.interactiveSession.sendLocalMessage(message);
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			input.interactiveSession.sendLocalMessage(
				`[ai-whisper] ${message}\n`,
			);
		}
	}

	return {
		async start() {
			await input.interactiveSession.start();

			if (ttyStdin.isTTY && typeof ttyStdin.setRawMode === "function" && !process.env.AI_WHISPER_ADOPTED_TTY) {
				ttyStdin.setRawMode(true);
			}

			input.stdin.on("data", (chunk: Buffer | string) => {
				void processChunk(String(chunk));
			});
		},
		async stop() {
			clearRelayPreview();
			if (ttyStdin.isTTY && typeof ttyStdin.setRawMode === "function" && !process.env.AI_WHISPER_ADOPTED_TTY) {
				ttyStdin.setRawMode(Boolean(previousRawMode));
			}
			await input.interactiveSession.stop();
		},
	};
}
