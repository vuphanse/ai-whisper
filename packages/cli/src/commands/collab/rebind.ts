import { createBrokerRuntime } from "@ai-whisper/broker";
import { readCliCollabState } from "../../runtime/state-file.js";
import { getStateFilePath } from "../../runtime/paths.js";
import { renderAttachSnippet } from "../../runtime/attach-snippet.js";
import { assertNormalBrokerState } from "../../runtime/recovery-guard.js";

export async function runCollabRebind(input: {
	workspaceRoot: string;
	target: "codex" | "claude";
	now: string;
	replace?: boolean;
	isInteractive: boolean;
	confirmReplace?: (message: string) => Promise<boolean>;
}) {
	if (!input.replace && !input.isInteractive) {
		throw new Error("Non-interactive rebind requires --replace.");
	}

	const label = input.target === "codex" ? "Codex" : "Claude";

	const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
	if (!state) {
		throw new Error("No active collab. Run `whisper collab start` first.");
	}

	assertNormalBrokerState(state);

	const broker = createBrokerRuntime({
		sqlitePath: state.broker.sqlitePath,
		host: state.broker.host,
		port: state.broker.port,
	});

	const current = broker.control
		.listSessionBindings(state.collabId)
		.find((binding) => binding.agentType === input.target);
	if (!current || current.bindingState !== "bound" || !current.activeSessionId) {
		throw new Error(`${label} is not currently bound. Use attach instead.`);
	}

	if (input.isInteractive && !input.replace) {
		const confirmed = await (input.confirmReplace ?? (() => Promise.resolve(false)))(
			`${label} is already bound. Replace it? [y/N] `,
		);
		if (!confirmed) {
			throw new Error("Rebind cancelled.");
		}
	}

	const claim = broker.control.issueAttachClaim({
		collabId: state.collabId,
		agentType: input.target,
		mode: "rebind",
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
