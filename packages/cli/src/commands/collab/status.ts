import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import {
	resolveCollab,
	CollabResolverError,
} from "../../runtime/collab-resolver.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";

export function runCollabStatus(input: {
	cwd: string;
	collabIdOverride?: string;
}): string {
	const sqlitePath = getSharedSqlitePath();
	if (!existsSync(sqlitePath)) {
		return `no active collab for ${input.cwd}`;
	}
	const db = new Database(sqlitePath, { readonly: true });
	try {
		const r = resolveCollab({
			db,
			cwd: input.cwd,
			...(input.collabIdOverride ? { collabIdOverride: input.collabIdOverride } : {}),
		});
		const daemonStr = r.daemon
			? `daemon: ${r.daemon.host}:${r.daemon.port} pid=${r.daemon.pid}`
			: "daemon: not running";
		return [
			`collabId: ${r.collabId}`,
			`workspace: ${r.workspaceRoot}`,
			`status: ${r.status}`,
			`launch: ${r.launch.mode}${r.launch.tmuxSession ? ` (tmux=${r.launch.tmuxSession})` : ""}`,
			daemonStr,
			`recovery: ${r.recovery.state}`,
		].join("\n");
	} catch (err) {
		if (err instanceof CollabResolverError && err.kind === "NoCollabFoundForCwd") {
			return `no active collab for ${input.cwd}`;
		}
		throw err;
	} finally {
		db.close();
	}
}
