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

export async function runCollabRebind(input: {
	workspaceRoot: string;
	target: "codex" | "claude";
	now: string;
	replace?: boolean;
	isInteractive: boolean;
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
	confirmReplace?: (message: string) => Promise<boolean>;
	assessBroker?: typeof assessBrokerDaemon;
}) {
	if (!input.replace && !input.isInteractive) {
		throw new Error("Non-interactive rebind requires --replace.");
	}

	const label = input.target === "codex" ? "Codex" : "Claude";

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
		mode: "rebind",
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
