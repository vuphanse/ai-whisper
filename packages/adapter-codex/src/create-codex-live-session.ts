import { createRequire } from "node:module";
import { spawn } from "node-pty";
import {
	appendInteractiveBrokerChunk,
	ensureNodePtySpawnHelperExecutable,
	mockProviderReplySchema,
	type InteractiveSessionController,
	type ProviderReply,
	type ProviderWorkRequest,
} from "@ai-whisper/shared";
import type { CodexCommandConfig } from "./codex-command.js";
import { buildCodexInteractiveBrokerPrompt } from "./codex-live-session-prompt.js";

const REPLY_TIMEOUT_MS = 15_000;
const SUBMIT_RETRY_MS = 1_500;
const RECENT_OUTPUT_LIMIT = 400;
const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const require = createRequire(import.meta.url);
const nodePtyUnixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");

type PtyLike = {
	onData(handler: (data: string) => void): unknown;
	write(data: string): void;
	kill(): void;
};

function createNodePty(input: { config: CodexCommandConfig; cwd: string }): PtyLike {
	ensureNodePtySpawnHelperExecutable({
		unixTerminalPath: nodePtyUnixTerminalPath,
	});
	return spawn(
		input.config.executable,
		input.config.execArgs,
		{
			name: "xterm-256color",
			cols: 120,
			rows: 40,
			cwd: input.cwd,
		},
	);
}

function submitPrompt(
	pty: PtyLike,
	input: { prompt: string; mode: "plain" | "bracketedPaste" },
) {
	if (input.mode === "plain") {
		pty.write(input.prompt);
		pty.write("\r");
		return;
	}

	pty.write(
		`${BRACKETED_PASTE_START}${input.prompt}${BRACKETED_PASTE_END}`,
	);
	pty.write("\r");
}

export function createCodexLiveSession(input: {
	config: CodexCommandConfig;
	cwd: string;
	stdout: NodeJS.WritableStream;
	createPty?: (input: { config: CodexCommandConfig; cwd: string }) => PtyLike;
}): InteractiveSessionController {
	let pty: PtyLike | null = null;
	let recentOutput = "";
	let frameState = { insideFrame: false, buffer: "" };
	let pending:
		| {
				resolve: (reply: ProviderReply) => void;
				timer: ReturnType<typeof setTimeout>;
				retryTimer: ReturnType<typeof setTimeout>;
				frameStarted: boolean;
				prompt: string;
				retried: boolean;
		  }
		| undefined;

	function appendRecentOutput(data: string) {
		recentOutput = (recentOutput + data).slice(-RECENT_OUTPUT_LIMIT);
	}

	function handleData(data: string) {
		appendRecentOutput(data);

		const result = appendInteractiveBrokerChunk(frameState, data);
		frameState = result.state;
		if (pending && (result.state.insideFrame || result.completedFrame !== null)) {
			pending.frameStarted = true;
		}

		if (result.completedFrame !== null && pending) {
			const { resolve, retryTimer, timer } = pending;
			pending = undefined;
			clearTimeout(timer);
			clearTimeout(retryTimer);

			let reply: ProviderReply;
			try {
				reply = mockProviderReplySchema.parse(
					JSON.parse(result.completedFrame),
				);
			} catch {
				reply = {
					kind: "failure",
					content: `Invalid broker reply JSON: ${result.completedFrame.slice(0, 200)}`,
					transitionIntent: "failed",
				};
			}

			resolve(reply);
			return;
		}

		if (!pending) {
			input.stdout.write(data);
		}
	}

	return {
		start() {
			pty = (input.createPty ?? createNodePty)({
				config: input.config,
				cwd: input.cwd,
			});
			pty.onData(handleData);
			return Promise.resolve();
		},
		stop() {
			if (pending) {
				clearTimeout(pending.timer);
				clearTimeout(pending.retryTimer);
				pending = undefined;
			}
			if (pty) {
				pty.kill();
				pty = null;
			}
			return Promise.resolve();
		},
		writeUserInput(data: string) {
			if (pending) return;
			pty?.write(data);
		},
		sendLocalMessage(message: string) {
			input.stdout.write(message);
		},
		runBrokerWork(request: ProviderWorkRequest): Promise<ProviderReply> {
			if (!pty) {
				return Promise.resolve({
					kind: "failure",
					content: "PTY session is not running",
					transitionIntent: "failed",
				});
			}
			if (pending) {
				return Promise.resolve({
					kind: "failure",
					content: "Another broker work request is already in progress",
					transitionIntent: "failed",
				});
			}

			const prompt = buildCodexInteractiveBrokerPrompt(request);
			frameState = { insideFrame: false, buffer: "" };
			recentOutput = "";

			return new Promise<ProviderReply>((resolve) => {
				const timer = setTimeout(() => {
					if (pending) {
						clearTimeout(pending.retryTimer);
						pending = undefined;
						resolve({
							kind: "failure",
							content: `Broker work timed out after ${REPLY_TIMEOUT_MS}ms. Recent output: ${recentOutput.slice(-200)}`,
							transitionIntent: "failed",
						});
					}
				}, REPLY_TIMEOUT_MS);
				const retryTimer = setTimeout(() => {
					if (!pty || !pending || pending.frameStarted || pending.retried) {
						return;
					}

					pending.retried = true;
					submitPrompt(pty, {
						prompt: pending.prompt,
						mode: "bracketedPaste",
					});
				}, SUBMIT_RETRY_MS);

				pending = {
					resolve,
					timer,
					retryTimer,
					frameStarted: false,
					prompt,
					retried: false,
				};
				submitPrompt(pty!, { prompt, mode: "plain" });
			});
		},
	};
}
