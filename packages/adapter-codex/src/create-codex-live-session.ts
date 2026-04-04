import { createRequire } from "node:module";
import { spawn } from "node-pty";
import {
	appendInteractiveBrokerChunk,
	ensureNodePtySpawnHelperExecutable,
	mockProviderReplySchema,
	InteractiveBrokerError,
	type InteractiveSessionController,
	type ProviderReply,
} from "@ai-whisper/shared";
import type { CodexCommandConfig } from "./codex-command.js";
import { buildCodexInteractiveBrokerPrompt } from "./codex-live-session-prompt.js";

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
	mode: "plain" | "bracketedPaste" | "linewise";
	lineTerminator?: "\r";
	submitTerminator: "\r" | "\n" | "\r\n";
	submitDelayMs: number;
};

const submitAttempts: SubmitAttempt[] = [
	{
		mode: "linewise",
		lineTerminator: "\r",
		submitTerminator: "\n",
		submitDelayMs: SUBMIT_DELAY_MS,
	},
	{
		mode: "linewise",
		lineTerminator: "\r",
		submitTerminator: "\r\n",
		submitDelayMs: SUBMIT_DELAY_MS,
	},
];

const submitStrategyNames: string[] = [
	"linewise_lf_delayed_submit",
	"linewise_crlf_delayed_submit",
];

function getSubmitStrategyName(index: number): string {
	return submitStrategyNames[Math.min(index, submitStrategyNames.length - 1)] ?? "linewise_delayed_submit";
}

function getSubmitAttempt(index: number): SubmitAttempt {
	return submitAttempts[
		Math.min(index, submitAttempts.length - 1)
	]!;
}

function isLikelyTerminalResponse(data: string) {
	return data.startsWith("\u001b");
}

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

function writePromptPrelude(
	pty: PtyLike,
	input: { prompt: string; attempt: SubmitAttempt },
) {
	if (input.attempt.mode === "linewise") {
		const lines = input.prompt.split("\n");
		for (const [index, line] of lines.entries()) {
			pty.write(line);
			if (index !== lines.length - 1) {
				pty.write(input.attempt.lineTerminator!);
			}
		}
		return;
	}

	if (input.attempt.mode === "plain") {
		pty.write(input.prompt);
		return;
	}

	pty.write(
		`${BRACKETED_PASTE_START}${input.prompt}${BRACKETED_PASTE_END}`,
	);
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
	};
}
