import { execSync } from "node:child_process";
import {
	applyMigrations,
	deleteBrokerDaemonByCollab,
	getBrokerDaemonByCollab,
	openDatabase,
} from "@ai-whisper/broker";
import { resolveCollab } from "../../runtime/collab-resolver.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";

export interface CollabStopOpts {
	cwd: string;
	collabIdOverride?: string;
	now: () => string;
	signalProcess: (pid: number, signal: "SIGTERM" | "SIGKILL") => void;
	/**
	 * Runs a shell command for tmux/terminal teardown. Injectable for tests;
	 * defaults to a best-effort `execSync` wrapper that swallows failures.
	 */
	execCommand?: (cmd: string) => void;
}

function defaultExecCommand(cmd: string): void {
	try {
		execSync(cmd, { stdio: "ignore" });
	} catch {
		// Session/window may already be gone — teardown is best-effort.
	}
}

function closeTerminalWindow(label: string, exec: (cmd: string) => void): void {
	if (process.platform === "darwin") {
		const escapedLabel = label.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
		exec(
			`osascript -e "tell application \\"Terminal\\" to close (every window whose custom title is \\"${escapedLabel}\\")"`,
		);
		return;
	}

	const escapedLabel = `'${label.replace(/'/g, "'\\''")}'`;
	exec(`pkill -f ${escapedLabel}`);
}

export function runCollabStop(input: CollabStopOpts): void {
	const exec = input.execCommand ?? defaultExecCommand;
	const db = openDatabase(getSharedSqlitePath());
	applyMigrations(db);
	let signalTarget: number | null = null;
	let tmuxSession: string | undefined;
	let attachments: { pid: number | null; windowLabel: string | null }[] = [];
	let relayMonitorWindowLabel: string | null = null;
	let relayMonitorPid: number | null = null;
	try {
		const resolved = resolveCollab({
			db,
			cwd: input.cwd,
			...(input.collabIdOverride
				? { collabIdOverride: input.collabIdOverride }
				: {}),
			requireActive: true,
		});
		tmuxSession = resolved.launch.tmuxSession;
		attachments = resolved.attachments.map((a) => ({
			pid: a.pid,
			windowLabel: a.windowLabel,
		}));
		const relayMonitorRow = db
			.prepare(
				"SELECT relay_monitor_window_label, relay_monitor_pid FROM collab WHERE collab_id = ?",
			)
			.get(resolved.collabId) as
			| {
					relay_monitor_window_label: string | null;
					relay_monitor_pid: number | null;
			  }
			| undefined;
		if (relayMonitorRow) {
			relayMonitorWindowLabel =
				relayMonitorRow.relay_monitor_window_label;
			relayMonitorPid = relayMonitorRow.relay_monitor_pid;
		}
		const tx = db.transaction(() => {
			const daemonRow = getBrokerDaemonByCollab(db, resolved.collabId);
			if (daemonRow && daemonRow.pid !== null) {
				signalTarget = daemonRow.pid;
			}
			deleteBrokerDaemonByCollab(db, resolved.collabId);
			const now = input.now();
			db.prepare(
				"UPDATE collab SET status='stopped', stopped_at=?, updated_at=? WHERE collab_id = ?",
			).run(now, now, resolved.collabId);
		});
		tx.immediate();
	} finally {
		db.close();
	}

	if (signalTarget !== null) {
		try {
			input.signalProcess(signalTarget, "SIGTERM");
		} catch {
			// process may already be dead
		}
	}

	if (tmuxSession) {
		const escaped = tmuxSession.replace(/'/g, "'\\''");
		exec(`tmux kill-session -t '${escaped}'`);
	}

	for (const attachment of attachments) {
		if (attachment.windowLabel) {
			try {
				closeTerminalWindow(attachment.windowLabel, exec);
			} catch {
				// Window may already be closed.
			}
		}
		if (attachment.pid !== null) {
			try {
				input.signalProcess(attachment.pid, "SIGTERM");
			} catch {
				// process may already be dead
			}
		}
	}

	// Terminal-mode relay-monitor lives on the collab row (not
	// session_attachment), so tear it down here too.
	if (relayMonitorWindowLabel) {
		try {
			closeTerminalWindow(relayMonitorWindowLabel, exec);
		} catch {
			// Window may already be closed.
		}
	}
	if (relayMonitorPid !== null) {
		try {
			input.signalProcess(relayMonitorPid, "SIGTERM");
		} catch {
			// process may already be dead
		}
	}
}
