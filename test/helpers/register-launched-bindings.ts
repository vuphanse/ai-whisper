import { createBrokerRuntime } from "@ai-whisper/broker";
import { createSessionId } from "@ai-whisper/shared";
import { createCliSessionId } from "../../packages/cli/src/runtime/id-factory.ts";
import { getStateFilePath } from "../../packages/cli/src/runtime/paths.ts";
import { readCliCollabState } from "../../packages/cli/src/runtime/state-file.ts";

/**
 * Test helper: simulates the binding state that exists after mount panes
 * complete their attach claim. Use in tests that combine runCollabStart with
 * runCollabTell/runCollabStatus — without this, the broker has no bound
 * sessions because start no longer pre-registers them.
 */
export async function registerLaunchedBindings(input: {
	workspaceRoot: string;
	now: string;
}) {
	const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
	if (!state) {
		throw new Error("registerLaunchedBindings: no collab state found");
	}

	const broker = createBrokerRuntime({
		sqlitePath: state.broker.sqlitePath,
		host: state.broker.host,
		port: state.broker.port,
	});

	try {
		for (const agentType of ["codex", "claude"] as const) {
			const sessionId = createSessionId(createCliSessionId(agentType, input.now));
			broker.control.registerSession({
				sessionId,
				collabId: state.collabId,
				agentType,
				capabilities: { supportsDirectPackets: true },
				now: input.now,
			});
			broker.control.setSessionBinding({
				collabId: state.collabId,
				agentType,
				sessionId,
				bindingSource: "mounted",
				now: input.now,
			});
		}
	} finally {
		await broker.stop();
	}
}
