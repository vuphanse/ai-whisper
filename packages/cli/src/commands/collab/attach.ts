import { createBrokerRuntime } from "@ai-whisper/broker";
import { readCliCollabState } from "../../runtime/state-file.js";
import { getStateFilePath } from "../../runtime/paths.js";
import { renderAttachSnippet } from "../../runtime/attach-snippet.js";
import { probeAndLatchBrokerState } from "../../runtime/recovery-guard.js";
import { assessBrokerDaemon } from "../../runtime/broker-daemon.js";
import {
	resolveCurrentTty as defaultResolveCurrentTty,
	validateExplicitTty as defaultValidateExplicitTty,
} from "../../runtime/adopted-session-target.js";
import { startAdoptionDaemon as defaultStartAdoptionDaemon } from "../../runtime/adopted-session-daemon.js";

type SnippetResult = {
	mode: "snippet";
	claim: ReturnType<ReturnType<typeof createBrokerRuntime>["control"]["issueAttachClaim"]>;
	snippet: string;
};

type AdoptedResult = {
	mode: "adopted";
	claim: ReturnType<ReturnType<typeof createBrokerRuntime>["control"]["issueAttachClaim"]>;
	ttyPath: string;
	daemonPid: number;
};

export async function runCollabAttach(input: {
	workspaceRoot: string;
	target: "codex" | "claude";
	now: string;
	targetMode?: "snippet_shell" | "adopt_current_tty" | "explicit_tty";
	explicitTtyPath?: string;
	resolveCurrentTty?: () => string;
	validateExplicitTty?: (ttyPath: string) => string;
	startAdoptionDaemon?: (input: {
		target: "codex" | "claude";
		workspaceRoot: string;
		ttyPath: string;
		claimId: string;
		secret: string;
	}) => number;
	assessBroker?: typeof assessBrokerDaemon;
}): Promise<SnippetResult | AdoptedResult> {
	const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
	if (!state) {
		throw new Error("No active collab. Run `whisper collab start` first.");
	}

	await probeAndLatchBrokerState(state, input.workspaceRoot, input.assessBroker);

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

	const targetMode = input.targetMode ?? "snippet_shell";
	const ttyPath =
		targetMode === "adopt_current_tty"
			? (input.resolveCurrentTty ?? defaultResolveCurrentTty)()
			: targetMode === "explicit_tty"
				? (input.validateExplicitTty ?? defaultValidateExplicitTty)(
						input.explicitTtyPath ?? "",
					)
				: null;

	const claim = broker.control.issueAttachClaim({
		collabId: state.collabId,
		agentType: input.target,
		mode: "attach",
		targetMode,
		targetTtyPath: ttyPath,
		now: input.now,
		expiresAt: new Date(Date.parse(input.now) + 5 * 60_000).toISOString(),
	});

	if (targetMode === "snippet_shell") {
		return {
			mode: "snippet" as const,
			claim,
			snippet: renderAttachSnippet({
				target: input.target,
				workspaceRoot: input.workspaceRoot,
				claimId: claim.claimId,
				secret: claim.secret,
			}),
		};
	}

	const daemonPid = (input.startAdoptionDaemon ?? defaultStartAdoptionDaemon)({
		target: input.target,
		workspaceRoot: input.workspaceRoot,
		ttyPath: ttyPath!,
		claimId: claim.claimId,
		secret: claim.secret,
	});

	return {
		mode: "adopted" as const,
		claim,
		ttyPath: ttyPath!,
		daemonPid,
	};
}
