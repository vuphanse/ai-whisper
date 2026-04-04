import { createRequire } from "node:module";
import { spawn } from "node-pty";
import {
	appendInteractiveBrokerChunk,
	ensureNodePtySpawnHelperExecutable,
	mockProviderReplySchema,
	InteractiveBrokerError,
	type BrokerArtifactHandle,
	type InteractiveSessionController,
	type ProviderReply,
	type ProviderWorkRequest,
} from "@ai-whisper/shared";
import type { ClaudeCommandConfig } from "./claude-command.js";
import { buildClaudeInteractiveBrokerPrompt } from "./claude-live-session-prompt.js";

const REPLY_TIMEOUT_MS = 15_000;
const SUBMIT_RETRY_MS = 1_500;
const FRAME_ARM_DELAY_MS = 300;
const SUBMIT_DELAY_MS = 75;
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

type SubmitAttempt = {
	mode: "bracketedPaste" | "plain";
	terminator: "\r" | "\n" | "\r\n";
	submitDelayMs: number;
};

const submitAttempts: SubmitAttempt[] = [
	{ mode: "plain", terminator: "\r", submitDelayMs: SUBMIT_DELAY_MS },
	{ mode: "plain", terminator: "\n", submitDelayMs: SUBMIT_DELAY_MS },
];

const submitStrategyNames: string[] = [
	"plain_cr_delayed_submit",
	"plain_lf_delayed_submit",
];

function getSubmitStrategyName(index: number): string {
	return submitStrategyNames[Math.min(index, submitStrategyNames.length - 1)] ?? "plain_delayed_submit";
}

function getSubmitAttempt(index: number): SubmitAttempt {
	return submitAttempts[
		Math.min(index, submitAttempts.length - 1)
	]!;
}

function isLikelyTerminalResponse(data: string) {
	return data.startsWith("\u001b");
}

function createNodePty(input: { config: ClaudeCommandConfig; cwd: string }): PtyLike {
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

function writePromptPrelude(
	pty: PtyLike,
	input: { prompt: string; attempt: SubmitAttempt },
) {
	if (input.attempt.mode === "plain") {
		pty.write(input.prompt);
		return;
	}

	pty.write(
		`${BRACKETED_PASTE_START}${input.prompt}${BRACKETED_PASTE_END}`,
	);
}

export function createClaudeLiveSession(input: {
	config: ClaudeCommandConfig;
	cwd: string;
	stdout: NodeJS.WritableStream;
	replyTimeoutMs?: number;
	createPty?: (input: { config: ClaudeCommandConfig; cwd: string }) => PtyLike;
}): InteractiveSessionController {
	const replyTimeoutMs = input.replyTimeoutMs ?? REPLY_TIMEOUT_MS;
	let pty: PtyLike | null = null;
	let recentOutput = "";
	let frameState = { insideFrame: false, buffer: "" };
	let pending:
		| {
				resolve: (reply: ProviderReply) => void;
				reject: (err: InteractiveBrokerError) => void;
				timer: ReturnType<typeof setTimeout>;
				retryTimer: ReturnType<typeof setTimeout>;
				submitTimer: ReturnType<typeof setTimeout>;
				frameArmTimer: ReturnType<typeof setTimeout>;
				frameArmed: boolean;
				frameStarted: boolean;
				attemptIndex: number;
				prompt: string;
				retried: boolean;
		  }
		| undefined;

	function appendRecentOutput(data: string) {
		recentOutput = (recentOutput + data).slice(-RECENT_OUTPUT_LIMIT);
	}

	function handleData(data: string) {
		appendRecentOutput(data);

		if (pending && !pending.frameArmed) {
			return;
		}

		const result = appendInteractiveBrokerChunk(frameState, data);
		frameState = result.state;
		if (pending && (result.state.insideFrame || result.completedFrame !== null)) {
			pending.frameStarted = true;
		}

		if (result.completedFrame !== null && pending) {
			const { resolve, reject, retryTimer, timer } = pending;
			clearTimeout(pending.submitTimer);
			clearTimeout(pending.frameArmTimer);
			pending = undefined;
			clearTimeout(timer);
			clearTimeout(retryTimer);

			let reply: ProviderReply;
			try {
				reply = mockProviderReplySchema.parse(
					JSON.parse(result.completedFrame),
				);
			} catch {
				reject(new InteractiveBrokerError("invalid_reply", `Invalid broker reply JSON: ${result.completedFrame.slice(0, 200)}`));
				return;
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
				clearTimeout(pending.submitTimer);
				clearTimeout(pending.frameArmTimer);
				const { reject } = pending;
				pending = undefined;
				reject(new InteractiveBrokerError("submit_failed", "Session stopped while broker work was pending"));
			}
			if (pty) {
				pty.kill();
				pty = null;
			}
			return Promise.resolve();
		},
		writeUserInput(data: string) {
			if (pending && !isLikelyTerminalResponse(data)) return;
			pty?.write(data);
		},
		sendLocalMessage(message: string) {
			input.stdout.write(message);
		},
		runBrokerWork(
			request: ProviderWorkRequest,
			artifactHandle: BrokerArtifactHandle,
			onAttemptStart?: (attemptNumber: number, strategy: string) => void,
		): Promise<ProviderReply> {
			if (!pty) {
				throw new InteractiveBrokerError("submit_failed", "PTY session is not running");
			}
			if (pending) {
				throw new InteractiveBrokerError("submit_failed", "Another broker work request is already in progress");
			}

			const prompt = buildClaudeInteractiveBrokerPrompt(artifactHandle.requestFilePath, artifactHandle.workItemId);
			frameState = { insideFrame: false, buffer: "" };
			recentOutput = "";

			return new Promise<ProviderReply>((resolve, reject) => {
				const scheduleAttempt = (attempt: SubmitAttempt, attemptNumber: number) => {
					onAttemptStart?.(attemptNumber, getSubmitStrategyName(attemptNumber - 1));
					writePromptPrelude(pty!, {
						prompt,
						attempt,
					});
					return setTimeout(() => {
						if (!pty || !pending) return;
						pty.write(attempt.terminator);
						pending.frameArmTimer = setTimeout(() => {
							if (pending) {
								frameState = { insideFrame: false, buffer: "" };
								pending.frameArmed = true;
							}
						}, FRAME_ARM_DELAY_MS);
					}, attempt.submitDelayMs);
				};

				const timer = setTimeout(() => {
					if (pending) {
						clearTimeout(pending.retryTimer);
						clearTimeout(pending.submitTimer);
						pending = undefined;
						reject(new InteractiveBrokerError("timed_out", `Broker work timed out after ${replyTimeoutMs}ms. Recent output: ${recentOutput.slice(-200)}`));
					}
				}, replyTimeoutMs);
				const retryTimer = setTimeout(() => {
					if (!pty || !pending || pending.frameStarted || pending.retried) {
						return;
					}

					pending.retried = true;
					pending.frameArmed = false;
					clearTimeout(pending.submitTimer);
					clearTimeout(pending.frameArmTimer);
					const nextIndex = Math.min(pending.attemptIndex + 1, submitAttempts.length - 1);
					const attempt = getSubmitAttempt(nextIndex);
					pending.submitTimer = scheduleAttempt(attempt, 2);
					pending.attemptIndex = nextIndex;
				}, SUBMIT_RETRY_MS);

				pending = {
					resolve,
					reject,
					timer,
					retryTimer,
					submitTimer: undefined as unknown as ReturnType<typeof setTimeout>,
					frameArmTimer: undefined as unknown as ReturnType<typeof setTimeout>,
					frameArmed: false,
					frameStarted: false,
					attemptIndex: 0,
					prompt,
					retried: false,
				};
				pending.submitTimer = scheduleAttempt(getSubmitAttempt(0), 1);
			});
		},
	};
}
