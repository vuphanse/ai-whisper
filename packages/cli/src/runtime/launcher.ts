import { execSync, spawn as nodeSpawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type LaunchMode = "tmux" | "terminals" | "none";

export type SpawnFn = (command: string) => number | void;
export type ExecFn = (command: string) => void;

const __dirname = dirname(fileURLToPath(import.meta.url));
const companionAgentPath = resolve(__dirname, "../bin/companion-agent.js");
const relayMonitorBinPath = resolve(__dirname, "../bin/relay-monitor.js");

function shellQuote(value: string): string {
	return `'${value.replace(/'/g, "'\\''")}'`;
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
	forceNoLaunch: boolean;
}): LaunchMode {
	if (input.forceNoLaunch) return "none";
	if (input.tmuxAvailable && !input.forceNoTmux) return "tmux";
	return "terminals";
}

function buildEnvPrefix(input: {
	brokerSqlitePath: string;
	brokerHost: string;
	brokerPort: number;
	collabId: string;
	sessionId: string;
}): string {
	const explicitEnv = {
		AI_WHISPER_BROKER_SQLITE: input.brokerSqlitePath,
		AI_WHISPER_BROKER_HOST: input.brokerHost,
		AI_WHISPER_BROKER_PORT: String(input.brokerPort),
		AI_WHISPER_COLLAB_ID: input.collabId,
		AI_WHISPER_SESSION_ID: input.sessionId,
	} as const;

	const passthrough = Object.entries(process.env)
		.filter(
			(entry): entry is [string, string] =>
				entry[0].startsWith("AI_WHISPER_") &&
				!(entry[0] in explicitEnv) &&
				typeof entry[1] === "string" &&
				entry[1].length > 0,
		)
		.map(([key, value]) => `${key}=${shellQuote(value)}`);

	return [
		...Object.entries(explicitEnv).map(
			([key, value]) => `${key}=${shellQuote(value)}`,
		),
		...passthrough,
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

function defaultExec(command: string): void {
	execSync(command, { stdio: "inherit" });
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
	attachTmux?: boolean;
	collabId: string;
	workspaceRoot: string;
	brokerSqlitePath: string;
	brokerHost: string;
	brokerPort: number;
	codexSessionId: string;
	claudeSessionId: string;
	spawn?: SpawnFn;
	exec?: ExecFn;
}): LaunchResult {
	if (input.launchMode === "none") {
		throw new Error("launchSessions must not be called with launchMode 'none'");
	}

	const run = input.spawn ?? defaultSpawn;
	const exec = input.exec ?? defaultExec;

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

		exec(
			`tmux new-session -d -s ${shellQuote(tmuxSession)} -n codex sh -lc ${shellQuote(codexCmd)}`,
		);
		exec(
			`tmux split-window -t ${shellQuote(`${tmuxSession}:0`)} -h sh -lc ${shellQuote(claudeCmd)}`,
		);
		const relayMonitorCmd = `AI_WHISPER_WORKSPACE_ROOT=${shellQuote(input.workspaceRoot)} ${shellQuote(process.execPath)} ${shellQuote(relayMonitorBinPath)}`;
		exec(
			`tmux split-window -t ${shellQuote(`${tmuxSession}:0`)} -v -l 30% sh -lc ${shellQuote(relayMonitorCmd)}`,
		);
		exec(
			`tmux set-option -t ${shellQuote(tmuxSession)} mouse on`,
		);
		if (input.attachTmux) {
			exec(`tmux attach -t ${shellQuote(tmuxSession)}`);
		}
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
