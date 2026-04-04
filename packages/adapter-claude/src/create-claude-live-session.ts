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
import type { ClaudeCommandConfig } from "./claude-command.js";
import { buildClaudeInteractiveBrokerPrompt } from "./claude-live-session-prompt.js";

const REPLY_TIMEOUT_MS = 15_000;
const RECENT_OUTPUT_LIMIT = 400;
const require = createRequire(import.meta.url);
const nodePtyUnixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");

export function createClaudeLiveSession(input: {
	config: ClaudeCommandConfig;
	cwd: string;
	stdout: NodeJS.WritableStream;
}): InteractiveSessionController {
	let pty: ReturnType<typeof spawn> | null = null;
	let recentOutput = "";
	let frameState = { insideFrame: false, buffer: "" };
	let pending:
		| {
				resolve: (reply: ProviderReply) => void;
				timer: ReturnType<typeof setTimeout>;
		  }
		| undefined;

	function appendRecentOutput(data: string) {
		recentOutput = (recentOutput + data).slice(-RECENT_OUTPUT_LIMIT);
	}

	function handleData(data: string) {
		appendRecentOutput(data);

		const result = appendInteractiveBrokerChunk(frameState, data);
		frameState = result.state;

		if (result.completedFrame !== null && pending) {
			const { resolve, timer } = pending;
			pending = undefined;
			clearTimeout(timer);

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
			ensureNodePtySpawnHelperExecutable({
				unixTerminalPath: nodePtyUnixTerminalPath,
			});
			pty = spawn(
				input.config.executable,
				input.config.execArgs,
				{
					name: "xterm-256color",
					cols: 120,
					rows: 40,
					cwd: input.cwd,
				},
			);
			pty.onData(handleData);
			return Promise.resolve();
		},
		stop() {
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

			const prompt = buildClaudeInteractiveBrokerPrompt(request);
			frameState = { insideFrame: false, buffer: "" };

			return new Promise<ProviderReply>((resolve) => {
				const timer = setTimeout(() => {
					if (pending) {
						pending = undefined;
						resolve({
							kind: "failure",
							content: `Broker work timed out after ${REPLY_TIMEOUT_MS}ms. Recent output: ${recentOutput.slice(-200)}`,
							transitionIntent: "failed",
						});
					}
				}, REPLY_TIMEOUT_MS);

				pending = { resolve, timer };
				pty!.write(`${prompt}\n`);
			});
		},
	};
}
