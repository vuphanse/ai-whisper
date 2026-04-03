import { execSync, spawn as nodeSpawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LaunchMode = "tmux" | "terminals";

export type SpawnFn = (command: string) => number | void;

const __dirname = dirname(fileURLToPath(import.meta.url));
const companionAgentPath = resolve(__dirname, "../bin/companion-agent.js");

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

export type LaunchResult = {
	launched: true;
	launchMode: LaunchMode;
	tmuxSession?: string;
	sessions: {
		codex: { sessionId: string };
		claude: { sessionId: string };
	};
	commands: {
		codex: string;
		claude: string;
	};
	runtime: {
		codexPid?: number;
		claudePid?: number;
		codexWindowLabel?: string;
		claudeWindowLabel?: string;
	};
};

export function detectTmux(): boolean {
	try {
		execSync("which tmux", { stdio: "ignore" });
		return true;
	} catch {
		return false;
	}
}

export function chooseLaunchMode(input: {
	tmuxAvailable: boolean;
	forceNoTmux: boolean;
}): LaunchMode {
	if (input.tmuxAvailable && !input.forceNoTmux) {
		return "tmux";
	}

	return "terminals";
}

function buildEnvPrefix(input: {
	brokerSqlitePath: string;
	brokerHost: string;
	brokerPort: number;
	collabId: string;
	sessionId: string;
}): string {
	return [
		`AI_WHISPER_BROKER_SQLITE=${shellQuote(input.brokerSqlitePath)}`,
		`AI_WHISPER_BROKER_HOST=${shellQuote(input.brokerHost)}`,
		`AI_WHISPER_BROKER_PORT=${shellQuote(String(input.brokerPort))}`,
		`AI_WHISPER_COLLAB_ID=${shellQuote(input.collabId)}`,
		`AI_WHISPER_SESSION_ID=${shellQuote(input.sessionId)}`,
	].join(" ");
}

function buildAgentCommand(
	agent: "codex" | "claude",
	envPrefix: string,
): string {
	return `${envPrefix} ${shellQuote(process.execPath)} ${shellQuote(companionAgentPath)} ${agent}`;
}

function defaultSpawn(command: string): number | undefined {
	const child = nodeSpawn("sh", ["-c", command], {
		detached: true,
		stdio: "ignore",
	});
	child.unref();
	return child.pid;
}

function wrapForTerminalWindow(agentCommand: string, label: string): string {
	if (process.platform === "darwin") {
		const escaped = agentCommand.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		const escapedLabel = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		return `osascript -e "tell application \\"Terminal\\" to do script \\"${escaped}\\"" -e "tell application \\"Terminal\\" to set custom title of front window to \\"${escapedLabel}\\""`;
	}
	return `x-terminal-emulator -e sh -lc ${shellQuote(agentCommand)} 2>/dev/null || xterm -title ${shellQuote(label)} -e sh -lc ${shellQuote(agentCommand)}`;
}

export function launchSessions(input: {
	launchMode: LaunchMode;
	collabId: string;
	workspaceRoot: string;
	brokerSqlitePath: string;
	brokerHost: string;
	brokerPort: number;
	codexSessionId: string;
	claudeSessionId: string;
	spawn?: SpawnFn;
}): LaunchResult {
	const run = input.spawn ?? defaultSpawn;

	const codexEnv = buildEnvPrefix({
		brokerSqlitePath: input.brokerSqlitePath,
		brokerHost: input.brokerHost,
		brokerPort: input.brokerPort,
		collabId: input.collabId,
		sessionId: input.codexSessionId,
	});
	const claudeEnv = buildEnvPrefix({
		brokerSqlitePath: input.brokerSqlitePath,
		brokerHost: input.brokerHost,
		brokerPort: input.brokerPort,
		collabId: input.collabId,
		sessionId: input.claudeSessionId,
	});

	const codexCmd = `cd ${shellQuote(input.workspaceRoot)} && ${buildAgentCommand("codex", codexEnv)}`;
	const claudeCmd = `cd ${shellQuote(input.workspaceRoot)} && ${buildAgentCommand("claude", claudeEnv)}`;
	const codexWindowLabel = "whisper-codex";
	const claudeWindowLabel = "whisper-claude";

	const base: LaunchResult = {
		launched: true,
		launchMode: input.launchMode,
		sessions: {
			codex: { sessionId: input.codexSessionId },
			claude: { sessionId: input.claudeSessionId },
		},
		commands: {
			codex: codexCmd,
			claude: claudeCmd,
		},
		runtime: {},
	};

	if (input.launchMode === "tmux") {
		const tmuxSession = `whisper-${input.collabId}`;
		base.tmuxSession = tmuxSession;

		run(`tmux new-session -d -s ${shellQuote(tmuxSession)} -n codex sh -lc ${shellQuote(codexCmd)}`);
		run(`tmux split-window -t ${shellQuote(tmuxSession)} -h sh -lc ${shellQuote(claudeCmd)}`);
	} else {
		base.runtime.codexWindowLabel = codexWindowLabel;
		base.runtime.claudeWindowLabel = claudeWindowLabel;
		const codexPid = run(wrapForTerminalWindow(codexCmd, codexWindowLabel));
		const claudePid = run(wrapForTerminalWindow(claudeCmd, claudeWindowLabel));
		if (typeof codexPid === "number") {
			base.runtime.codexPid = codexPid;
		}
		if (typeof claudePid === "number") {
			base.runtime.claudePid = claudePid;
		}
	}

	return base;
}
