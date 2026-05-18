import {
	createClaudeLiveSession,
	createClaudeProvider,
} from "@ai-whisper/adapter-claude";
import {
	createCodexLiveSession,
	createCodexProvider,
} from "@ai-whisper/adapter-codex";
import type { InteractiveSessionController } from "@ai-whisper/shared";
import { getLiveSessionBrokerTempRoot } from "./paths.js";

export function getInteractiveSessionExecArgsForTarget(
	target: "codex" | "claude",
): string[] {
	const tempRoot = getLiveSessionBrokerTempRoot();

	if (target === "codex") {
		// Full autonomy: the relay drives codex unattended, so it must run
		// with no approval prompts and no sandbox gating.
		return ["--dangerously-bypass-approvals-and-sandbox", "--add-dir", tempRoot];
	}

	// Full autonomy: bypass all permission checks so the relay can drive
	// claude unattended (file writes + bash).
	return ["--add-dir", tempRoot, "--dangerously-skip-permissions"];
}

export function getProviderExecArgsForTarget(target: "codex" | "claude"): string[] {
	const tempRoot = getLiveSessionBrokerTempRoot();

	if (target === "codex") {
		return [
			"exec",
			"--dangerously-bypass-approvals-and-sandbox",
			"--add-dir",
			tempRoot,
		];
	}

	return ["-p", "--add-dir", tempRoot, "--dangerously-skip-permissions"];
}

export function createProviderForTarget(target: "codex" | "claude") {
	if (target === "codex") {
		return createCodexProvider({
			executable: process.env.AI_WHISPER_CODEX_CMD ?? "codex",
			execArgs: getProviderExecArgsForTarget("codex"),
		});
	}
	return createClaudeProvider({
		executable: process.env.AI_WHISPER_CLAUDE_CMD ?? "claude",
		execArgs: getProviderExecArgsForTarget("claude"),
	});
}

export function createInteractiveSessionForTarget(input: {
	target: "codex" | "claude";
	cwd: string;
	stdout: NodeJS.WritableStream;
	replyTimeoutMs?: number;
}): InteractiveSessionController {
	const execArgs = getInteractiveSessionExecArgsForTarget(input.target);
	if (input.target === "codex") {
		return createCodexLiveSession({
			config: {
				executable: process.env.AI_WHISPER_CODEX_CMD ?? "codex",
				execArgs,
			},
			cwd: input.cwd,
			stdout: input.stdout,
			...(input.replyTimeoutMs !== undefined
				? { replyTimeoutMs: input.replyTimeoutMs }
				: {}),
		});
	}
	return createClaudeLiveSession({
		config: {
			executable: process.env.AI_WHISPER_CLAUDE_CMD ?? "claude",
			execArgs,
		},
		cwd: input.cwd,
		stdout: input.stdout,
		...(input.replyTimeoutMs !== undefined
			? { replyTimeoutMs: input.replyTimeoutMs }
			: {}),
	});
}

