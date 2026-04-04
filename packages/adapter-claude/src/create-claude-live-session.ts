import { createRequire } from "node:module";
import { spawn } from "node-pty";
import {
	ensureNodePtySpawnHelperExecutable,
	type InteractiveSessionController,
} from "@ai-whisper/shared";
import type { ClaudeCommandConfig } from "./claude-command.js";

const require = createRequire(import.meta.url);
const nodePtyUnixTerminalPath = require.resolve("node-pty/lib/unixTerminal.js");

type PtyLike = {
	onData(handler: (data: string) => void): unknown;
	write(data: string): void;
	kill(): void;
};

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

export function createClaudeLiveSession(input: {
	config: ClaudeCommandConfig;
	cwd: string;
	stdout: NodeJS.WritableStream;
	createPty?: (input: { config: ClaudeCommandConfig; cwd: string }) => PtyLike;
}): InteractiveSessionController {
	let pty: PtyLike | null = null;

	function handleData(data: string) {
		input.stdout.write(data);
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
			if (pty) {
				pty.kill();
				pty = null;
			}
			return Promise.resolve();
		},
		writeUserInput(data: string) {
			pty?.write(data);
		},
		sendLocalMessage(message: string) {
			input.stdout.write(message);
		},
	};
}
