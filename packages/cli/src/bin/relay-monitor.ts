#!/usr/bin/env node
import { runCollabRelayMonitor } from "../commands/collab/relay-monitor.js";

const workspaceRoot = process.env.AI_WHISPER_WORKSPACE_ROOT ?? process.cwd();
runCollabRelayMonitor({ workspaceRoot }).catch((err: unknown) => {
	console.error(err instanceof Error ? err.message : err);
	process.exit(1);
});
