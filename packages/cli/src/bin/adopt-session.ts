#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { createBrokerRuntime } from "@ai-whisper/broker";
import { createAdoptSessionRuntime } from "../runtime/adopt-session-main.js";
import { readCliCollabState } from "../runtime/state-file.js";
import { getStateFilePath } from "../runtime/paths.js";

// Set environment flag so live-session runtime skips raw-mode toggling
process.env.AI_WHISPER_ADOPTED_TTY = "1";

const isEntryPoint = process.argv[1] === fileURLToPath(import.meta.url);

if (isEntryPoint) {
	const args = process.argv.slice(2);
	const target = args[0] as "codex" | "claude";
	const workspaceArgIdx = args.indexOf("--workspace");
	const ttyArgIdx = args.indexOf("--tty");
	const claimIdArgIdx = args.indexOf("--claim-id");
	const secretArgIdx = args.indexOf("--secret");
	const workspaceRoot = workspaceArgIdx !== -1 ? args[workspaceArgIdx + 1] : undefined;
	const ttyPath = ttyArgIdx !== -1 ? args[ttyArgIdx + 1] : undefined;
	const claimId = claimIdArgIdx !== -1 ? args[claimIdArgIdx + 1] : undefined;
	const secret = secretArgIdx !== -1 ? args[secretArgIdx + 1] : undefined;

	if (!target || !workspaceRoot || !ttyPath || !claimId || !secret) {
		console.error("Usage: adopt-session <codex|claude> --workspace <path> --tty <path> --claim-id <id> --secret <secret>");
		process.exit(1);
	}

	const state = readCliCollabState(getStateFilePath(workspaceRoot));
	if (!state) {
		console.error("No active collab found at the workspace root.");
		process.exit(1);
	}

	const broker = createBrokerRuntime({
		sqlitePath: state.broker.sqlitePath,
		host: state.broker.host,
		port: state.broker.port,
	});

	createAdoptSessionRuntime({
		target,
		workspaceRoot,
		ttyPath,
		claimId,
		secret,
		broker,
	}).start().catch((err: unknown) => {
		console.error(err);
		process.exit(1);
	});
}
