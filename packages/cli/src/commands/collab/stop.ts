import { execSync } from "node:child_process";
import { getStateFilePath } from "../../runtime/paths.js";
import {
	findPortOwnerPid as defaultFindPortOwnerPid,
	isPortFree as defaultIsPortFree,
} from "../../runtime/port-utils.js";
import {
	clearCliCollabState,
	readCliCollabState,
} from "../../runtime/state-file.js";

const DEFAULT_BROKER_PORT = 4311;
const SIGTERM_GRACE_MS = 1_000;

function closeTerminalWindow(label: string): void {
	if (process.platform === "darwin") {
		const escapedLabel = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		execSync(
			`osascript -e "tell application \\"Terminal\\" to close (every window whose custom title is \\"${escapedLabel}\\")"`,
			{ stdio: "ignore" },
		);
		return;
	}

	const escapedLabel = `'${label.replace(/'/g, "'\\''")}'`;
	execSync(`pkill -f ${escapedLabel}`, { stdio: "ignore" });
}

function defaultPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function defaultKill(pid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(pid, signal);
	} catch {
		// Already dead or permission — callers treat as best-effort.
	}
}

function defaultSleep(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCollabStop(input: {
	workspaceRoot: string;
	killProcess?: (pid: number, signal: NodeJS.Signals) => void;
	pidAlive?: (pid: number) => boolean;
	isPortFree?: (port: number) => Promise<boolean>;
	findPortOwnerPid?: (port: number) => number | null;
	sleep?: (ms: number) => Promise<void>;
}) {
	const kill = input.killProcess ?? defaultKill;
	const pidAlive = input.pidAlive ?? defaultPidAlive;
	const isPortFree = input.isPortFree ?? defaultIsPortFree;
	const findPortOwnerPid =
		input.findPortOwnerPid ?? defaultFindPortOwnerPid;
	const sleep = input.sleep ?? defaultSleep;

	const statePath = getStateFilePath(input.workspaceRoot);
	const state = readCliCollabState(statePath);

	if (!state) {
		return { stopped: false as const, message: "No active collab." };
	}

	if (state.launch?.tmuxSession) {
		try {
			execSync(
				`tmux kill-session -t '${state.launch.tmuxSession.replace(/'/g, "'\\''")}'`,
				{
					stdio: "ignore",
				},
			);
		} catch {
			// Session may already be gone.
		}
	}

	for (const session of [
		state.ownedSessions.codex,
		state.ownedSessions.claude,
	]) {
		if (!session) continue;
		if (session.windowLabel) {
			try {
				closeTerminalWindow(session.windowLabel);
			} catch {
				// Window may already be closed.
			}
		}

		if (session.pid) {
			kill(session.pid, "SIGTERM");
		}
	}

	for (const session of [
		state.adoptedSessions.codex,
		state.adoptedSessions.claude,
	]) {
		if (!session) continue;
		kill(session.daemonPid, "SIGTERM");
	}

	for (const session of [
		state.mountedSessions.codex,
		state.mountedSessions.claude,
	]) {
		if (!session) continue;
		kill(session.sessionPid, "SIGTERM");
	}

	const brokerPort = state.broker.port ?? DEFAULT_BROKER_PORT;
	const brokerPid = state.broker.pid;

	if (brokerPid) {
		kill(brokerPid, "SIGTERM");
		await sleep(SIGTERM_GRACE_MS);
		if (pidAlive(brokerPid)) {
			kill(brokerPid, "SIGKILL");
			await sleep(100);
		}
	}

	// Port fallback: if :4311 still held after pid kill attempts, find the
	// owner and SIGKILL it. Covers leaked broker daemons whose pid no longer
	// matches the state file (e.g. earlier start that crashed without clearing state).
	if (!(await isPortFree(brokerPort))) {
		const ownerPid = findPortOwnerPid(brokerPort);
		if (ownerPid !== null && ownerPid !== brokerPid) {
			kill(ownerPid, "SIGKILL");
			await sleep(100);
		}
	}

	clearCliCollabState(statePath);
	return { stopped: true as const, collabId: state.collabId };
}
