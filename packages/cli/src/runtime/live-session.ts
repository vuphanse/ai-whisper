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
import {
	normalizeTerminalInput,
	type NormalizedInputState,
} from "./terminal-input-normalizer.js";

const ORANGE_RELAY = "\u001b[38;5;215m";
const ANSI_RESET = "\u001b[0m";
const CLEAR_LINE = "\r\u001b[2K";
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
	externalInputGate?: {
		isBlocked(): boolean;
		renderBlockedMessage(): string;
		onCancel(): void;
	};
	externalInputRouter?: {
		handleInput(text: string): Promise<boolean> | boolean;
	};
}) {
	const ttyStdin = input.stdin as NodeJS.ReadableStream & {
		isTTY?: boolean;
		isRaw?: boolean;
		setRawMode?: (mode: boolean) => void;
	};
	const previousRawMode = ttyStdin.isRaw;
	const canManageRawMode =
		ttyStdin.isTTY &&
		typeof ttyStdin.setRawMode === "function" &&
		!process.env.AI_WHISPER_ADOPTED_TTY;
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
	let pausedInputDepth = 0;

	function setMountedRawMode(mode: boolean) {
		if (canManageRawMode) {
			ttyStdin.setRawMode?.(mode);
		}
	}

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
		if (pausedInputDepth > 0) {
			return;
		}

		if (input.externalInputRouter) {
			const handled = await input.externalInputRouter.handleInput(sanitized);
			if (handled) {
				return;
			}
		}

		// Block input while the external turn gate is active (e.g. waiting for the
		// other agent to hand back the turn). Only Ctrl+C is allowed as a cancel signal.
		if (input.externalInputGate?.isBlocked()) {
			input.interactiveSession.sendLocalMessage(
				`\r\u001b[2K${input.externalInputGate.renderBlockedMessage()}`,
			);
			if (sanitized.includes("\x03")) {
				input.externalInputGate.onCancel();
			}
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

			setMountedRawMode(true);

			input.stdin.on("data", (chunk: Buffer | string) => {
				void processChunk(String(chunk));
			});
		},
		async withPausedInput<T>(run: () => Promise<T>): Promise<T> {
			pausedInputDepth += 1;
			if (pausedInputDepth === 1) {
				clearRelayPreview();
				setMountedRawMode(false);
			}
			try {
				return await run();
			} finally {
				pausedInputDepth = Math.max(0, pausedInputDepth - 1);
				if (pausedInputDepth === 0) {
					setMountedRawMode(true);
				}
			}
		},
		async stop() {
			clearRelayPreview();
			setMountedRawMode(Boolean(previousRawMode));
			await input.interactiveSession.stop();
		},
	};
}
