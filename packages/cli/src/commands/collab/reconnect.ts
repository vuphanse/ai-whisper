import { createBrokerRuntime } from "@ai-whisper/broker";
import { renderAttachSnippet } from "../../runtime/attach-snippet.js";
import { readCliCollabState } from "../../runtime/state-file.js";
import { getStateFilePath } from "../../runtime/paths.js";

export function runCollabReconnect(input: {
	workspaceRoot: string;
	target: "codex" | "claude";
	now: string;
}) {
	const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
	if (!state) {
		throw new Error("No active collab. Run `whisper collab start` first.");
	}
	if (state.recovery.state !== "recovered") {
		throw new Error("Collab has not been recovered. Run `whisper collab recover` first.");
	}

	const broker = createBrokerRuntime({
		sqlitePath: state.broker.sqlitePath,
		host: state.broker.host,
		port: state.broker.port,
	});

	const current = broker.control
		.listSessionBindings(state.collabId)
		.find((binding) => binding.agentType === input.target);
	if (!current?.activeSessionId) {
		void broker.stop();
		throw new Error(
			`${input.target === "codex" ? "Codex" : "Claude"} has no remembered binding to reconnect.`,
		);
	}

	const boundSession = broker.control
		.listSessions(state.collabId)
		.find((session) => session.sessionId === current.activeSessionId);
	if (boundSession?.healthState === "healthy") {
		void broker.stop();
		throw new Error(
			`${input.target === "codex" ? "Codex" : "Claude"} is already healthy. Reconnect is not needed.`,
		);
	}

	const claim = broker.control.issueAttachClaim({
		collabId: state.collabId,
		agentType: input.target,
		mode: "reconnect",
		now: input.now,
		expiresAt: new Date(Date.parse(input.now) + 5 * 60_000).toISOString(),
	});

	void broker.stop();

	return {
		claim,
		snippet: renderAttachSnippet({
			target: input.target,
			workspaceRoot: input.workspaceRoot,
			claimId: claim.claimId,
			secret: claim.secret,
		}),
	};
}

