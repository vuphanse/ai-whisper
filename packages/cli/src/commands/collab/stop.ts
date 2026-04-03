import { execSync } from "node:child_process";
import { getStateFilePath } from "../../runtime/paths.js";
import {
	clearCliCollabState,
	readCliCollabState,
} from "../../runtime/state-file.js";

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

export function runCollabStop(input: { workspaceRoot: string }) {
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

	for (const session of [state.sessions.codex, state.sessions.claude]) {
		if (session.windowLabel) {
			try {
				closeTerminalWindow(session.windowLabel);
			} catch {
				// Window may already be closed.
			}
		}

		if (session.pid) {
			try {
				process.kill(session.pid, "SIGTERM");
			} catch {
				// Process may already be dead.
			}
		}
	}

	// Kill the broker daemon if still running
	if (state.broker.pid) {
		try {
			process.kill(state.broker.pid, "SIGTERM");
		} catch {
			// Process may already be dead — that's fine
		}
	}

	clearCliCollabState(statePath);
	return { stopped: true as const, collabId: state.collabId };
}
