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
import { createBusyIndicator } from "./busy-indicator.js";
import type { createRelayPaneWriter } from "./relay-pane-writer.js";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ORANGE_RELAY = "\u001b[38;5;215m";
const ANSI_RESET = "\u001b[0m";
const CLEAR_LINE = "\r\u001b[2K";
const terminalResponsePatterns = [
	new RegExp(`${ESC}\\[[0-9;]*R`, "g"),
	new RegExp(`${ESC}\\[[?>0-9;]*c`, "g"),
	new RegExp(`${ESC}\\[\\?[0-9;:]*u`, "g"),
	new RegExp(`${ESC}\\[(?:I|O)`, "g"),
	new RegExp(`${ESC}\\[<[^${BEL}${ESC}]*[Mm]`, "g"),
	new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g"),
];
const csiKeyboardSequencePattern = new RegExp(
	`${ESC}\\[(\\d+)(?::(\\d+))?(?:;(\\d+)(?::(\\d+))?)?u`,
	"g",
);

function stripTerminalResponses(raw: string): string {
	return terminalResponsePatterns.reduce(
		(text, pattern) => text.replace(pattern, ""),
		raw,
	);
}

type NormalizedInputState = Record<string, never>;

function decodePrintableCsiKeyboardSequence(
	primaryCodepointText: string,
	alternateCodepointText?: string,
	modifiersText?: string,
	eventTypeText?: string,
): string | null {
	if (eventTypeText !== undefined) {
		return "";
	}

	const primaryCodepoint = Number(primaryCodepointText);
	const alternateCodepoint =
		alternateCodepointText !== undefined ? Number(alternateCodepointText) : null;
	const modifiers = modifiersText !== undefined ? Number(modifiersText) : 1;
	const decodedCodepoint = alternateCodepoint ?? primaryCodepoint;
	const modifierBits = Math.max(0, modifiers - 1);
	const hasCtrl = (modifierBits & 0b100) !== 0;

	if (!Number.isInteger(decodedCodepoint) || decodedCodepoint < 0) {
		return null;
	}

	if (hasCtrl) {
		const controlCodepoint = primaryCodepoint & 0x1f;
		if (controlCodepoint >= 0x00 && controlCodepoint <= 0x1f) {
			return String.fromCodePoint(controlCodepoint);
		}
	}

	// Mounted terminals already deliver printable text as ordinary bytes.
	// Drop printable CSI-u key reports so providers like Codex do not see
	// each keystroke twice, but still translate line-editing controls.
	const isLineEditingControl =
		decodedCodepoint === 0x09 ||
		decodedCodepoint === 0x0d ||
		decodedCodepoint === 0x08 ||
		decodedCodepoint === 0x7f;
	if (isLineEditingControl && modifiers <= 4) {
		try {
			return String.fromCodePoint(decodedCodepoint);
		} catch {
			return null;
		}
	}

	const isPrintable =
		decodedCodepoint >= 0x20 && decodedCodepoint !== 0x7f;
	if (isPrintable) {
		return "";
	}

	if (modifiers > 4) {
		return null;
	}

	return null;
}

function decodeCsiKeyboardInput(input: {
	raw: string;
	state: NormalizedInputState;
}): { text: string; state: NormalizedInputState } {
	let output = "";
	let lastIndex = 0;

	for (const match of input.raw.matchAll(csiKeyboardSequencePattern)) {
		const fullMatch = match[0];
		const index = match.index ?? 0;
		output += input.raw.slice(lastIndex, index);

		const decoded = decodePrintableCsiKeyboardSequence(
			match[1] ?? "",
			match[2],
			match[3],
			match[4],
		);
		if (decoded === null) {
			output += fullMatch;
		} else if (decoded.length > 0) {
			output += decoded;
		}

		lastIndex = index + fullMatch.length;
	}

	output += input.raw.slice(lastIndex);
	return {
		text: output,
		state: input.state,
	};
}

function normalizeTerminalInput(input: {
	raw: string;
	state: NormalizedInputState;
}): { text: string; state: NormalizedInputState } {
	return decodeCsiKeyboardInput({
		raw: stripTerminalResponses(input.raw),
		state: input.state,
	});
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
	onRelayCancel?: () => void;
	relayPaneWriter?: ReturnType<typeof createRelayPaneWriter> | undefined;
}) {
	const ttyStdin = input.stdin as NodeJS.ReadableStream & {
		isTTY?: boolean;
		isRaw?: boolean;
		setRawMode?: (mode: boolean) => void;
	};
	const previousRawMode = ttyStdin.isRaw;
	const debugLogPath = process.env.AI_WHISPER_DEBUG_INPUT_LOG;
	const busyIndicator = createBusyIndicator({
		write: (data) => input.interactiveSession.sendLocalMessage(data),
	});
	const lineBuffer = createRelayLineBuffer({
		getError: getRelayDirectiveError,
		isRelayDirective: (line) => parseRelayDirective(line) !== null,
		isRelayPrefix: (line) =>
			["@@codex", "@@claude", "@@pull"].some(
				(target) => target.startsWith(line) || line.startsWith(target),
			),
	});
	let relayPreviewVisible = false;
	let inputState: NormalizedInputState = {};

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
		const normalized = normalizeTerminalInput({
			raw,
			state: inputState,
		});
		inputState = normalized.state;
		const sanitized = normalized.text;
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

		// Block input while relay work is in progress
		if (busyIndicator.isBusy()) {
			// Only allow Ctrl+C (0x03) to trigger cancellation
			if (sanitized.includes("\x03")) {
				if (input.onRelayCancel) {
					input.onRelayCancel();
				}
				busyIndicator.hide();
				if (input.relayPaneWriter) {
					input.relayPaneWriter.cancellation({
						agent: "user",
						content: "relay work cancelled by user",
						now: new Date().toISOString(),
					});
				}
			}
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

		busyIndicator.show({
			senderAgent: directive.target === "pull" ? "pull" : directive.target,
			instruction: directive.instruction || "pull context",
		});

		try {
			const message = await input.onRelay(
				directive,
				(msg) => {
					if (input.relayPaneWriter) {
						input.relayPaneWriter.status({ content: msg, now: new Date().toISOString() });
					} else {
						input.interactiveSession.sendLocalMessage(msg);
					}
				},
			);
			if (message) {
				if (input.relayPaneWriter) {
					input.relayPaneWriter.status({ content: message, now: new Date().toISOString() });
				} else {
					input.interactiveSession.sendLocalMessage(message);
				}
			}
		} catch (error) {
			const message =
				error instanceof Error ? error.message : String(error);
			input.interactiveSession.sendLocalMessage(
				`[ai-whisper] ${message}\n`,
			);
		} finally {
			busyIndicator.hide();
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
