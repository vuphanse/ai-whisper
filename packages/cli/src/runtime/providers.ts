import {
	createClaudeLiveSession,
	createClaudeProvider,
} from "@ai-whisper/adapter-claude";
import {
	createCodexLiveSession,
	createCodexProvider,
} from "@ai-whisper/adapter-codex";
import type { InteractiveSessionController } from "@ai-whisper/shared";

export function createProviderForTarget(target: "codex" | "claude") {
	if (target === "codex") {
		return createCodexProvider({
			executable: process.env.AI_WHISPER_CODEX_CMD ?? "codex",
			execArgs: ["exec"],
		});
	}
	return createClaudeProvider({
		executable: process.env.AI_WHISPER_CLAUDE_CMD ?? "claude",
		execArgs: ["-p"],
	});
}

export function createInteractiveSessionForTarget(input: {
	target: "codex" | "claude";
	cwd: string;
	stdout: NodeJS.WritableStream;
}): InteractiveSessionController {
	if (input.target === "codex") {
		return createCodexLiveSession({
			config: {
				executable: process.env.AI_WHISPER_CODEX_CMD ?? "codex",
				execArgs: [],
			},
			cwd: input.cwd,
			stdout: input.stdout,
		});
	}
	return createClaudeLiveSession({
		config: {
			executable: process.env.AI_WHISPER_CLAUDE_CMD ?? "claude",
			execArgs: [],
		},
		cwd: input.cwd,
		stdout: input.stdout,
	});
}
