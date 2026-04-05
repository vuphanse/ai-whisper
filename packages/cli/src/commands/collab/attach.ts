import { createBrokerRuntime } from "@ai-whisper/broker";
import { readCliCollabState } from "../../runtime/state-file.js";
import { getStateFilePath } from "../../runtime/paths.js";
import { renderAttachSnippet } from "../../runtime/attach-snippet.js";

export async function runCollabAttach(input: {
	workspaceRoot: string;
	target: "codex" | "claude";
	now: string;
}) {
	const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
	if (!state) {
		throw new Error("No active collab. Run `whisper collab start` first.");
	}

	const broker = createBrokerRuntime({
		sqlitePath: state.broker.sqlitePath,
		host: state.broker.host,
		port: state.broker.port,
	});

	const current = broker.control
		.listSessionBindings(state.collabId)
		.find((binding) => binding.agentType === input.target);
	if (current?.bindingState === "bound") {
		throw new Error(
			`${input.target === "codex" ? "Codex" : "Claude"} is already bound. Use rebind to replace it.`,
		);
	}

	const claim = broker.control.issueAttachClaim({
		collabId: state.collabId,
		agentType: input.target,
		mode: "attach",
		now: input.now,
		expiresAt: new Date(Date.parse(input.now) + 5 * 60_000).toISOString(),
	});

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
