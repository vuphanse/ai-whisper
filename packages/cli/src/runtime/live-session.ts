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
	onRelay: (directive: RelayDirective) => Promise<string>;
}) {
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
			const message = await input.onRelay(directive);
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

			input.stdin.on("data", (chunk: Buffer | string) => {
				void processChunk(String(chunk));
			});
		},
		async stop() {
			await input.interactiveSession.stop();
		},
	};
}
