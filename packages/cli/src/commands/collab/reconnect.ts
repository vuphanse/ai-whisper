import { createBrokerRuntime } from "@ai-whisper/broker";
import { renderAttachSnippet } from "../../runtime/attach-snippet.js";
import { readCliCollabState } from "../../runtime/state-file.js";
import { getStateFilePath } from "../../runtime/paths.js";
import {
	resolveCurrentTty as defaultResolveCurrentTty,
	validateExplicitTty as defaultValidateExplicitTty,
} from "../../runtime/adopted-session-target.js";
import { startAdoptionDaemon as defaultStartAdoptionDaemon } from "../../runtime/adopted-session-daemon.js";

export function runCollabReconnect(input: {
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

	// When no explicit targetMode is provided, default based on how the role was previously bound.
	// A session that was adopted should reconnect via adoption, not a paste snippet.
	const defaultMode: "snippet_shell" | "adopt_current_tty" =
		current.bindingSource === "adopted" ? "adopt_current_tty" : "snippet_shell";
	const targetMode = input.targetMode ?? defaultMode;
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
		mode: "reconnect",
		targetMode,
		targetTtyPath: ttyPath,
		now: input.now,
		expiresAt: new Date(Date.parse(input.now) + 5 * 60_000).toISOString(),
	});

	void broker.stop();

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

