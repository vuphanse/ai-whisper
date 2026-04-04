import type {
	InteractiveSessionController,
	RelayDirective,
} from "@ai-whisper/shared";
import {
	getRelayDirectiveError,
	parseRelayDirective,
} from "./relay-directive.js";
import { createRelayLineBuffer } from "./relay-line-buffer.js";

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
	const lineBuffer = createRelayLineBuffer({
		getError: getRelayDirectiveError,
		isRelayCandidate: (line) =>
			["@@codex", "@@claude"].some(
				(target) => target.startsWith(line) || line.startsWith(target),
			),
	});

	async function processChunk(raw: string) {
		for (const decision of lineBuffer.push(raw)) {
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

			if (ttyStdin.isTTY && typeof ttyStdin.setRawMode === "function") {
				ttyStdin.setRawMode(true);
			}

			input.stdin.on("data", (chunk: Buffer | string) => {
				void processChunk(String(chunk));
			});
		},
		async stop() {
			if (ttyStdin.isTTY && typeof ttyStdin.setRawMode === "function") {
				ttyStdin.setRawMode(Boolean(previousRawMode));
			}
			await input.interactiveSession.stop();
		},
	};
}
