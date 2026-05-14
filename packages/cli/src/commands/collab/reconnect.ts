import { createBrokerRuntime, type BrokerRuntime } from "@ai-whisper/broker";
import { readCliCollabState } from "../../runtime/state-file.js";
import { getStateFilePath } from "../../runtime/paths.js";
import { resolveCurrentTty as defaultResolveCurrentTty } from "../../runtime/current-tty.js";
import { createMountSessionRuntime } from "../../runtime/mount-session-main.js";

export async function runCollabReconnect(input: {
	workspaceRoot: string;
	target: "codex" | "claude";
	now: string;
	resolveCurrentTty?: () => string;
	startMountedSession?: (input: {
		target: "codex" | "claude";
		workspaceRoot: string;
		ttyPath: string;
		claimId: string;
		secret: string;
		broker: BrokerRuntime;
	}) => Promise<void>;
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

	const ttyPath = (input.resolveCurrentTty ?? defaultResolveCurrentTty)();

	const claim = broker.control.issueAttachClaim({
		collabId: state.collabId,
		agentType: input.target,
		mode: "reconnect",
		targetMode: "mount_current_tty",
		targetTtyPath: ttyPath,
		now: input.now,
		expiresAt: new Date(Date.parse(input.now) + 5 * 60_000).toISOString(),
	});

	await (input.startMountedSession ??
		(async (mountedInput) => {
			const runtime = createMountSessionRuntime(mountedInput);
			await runtime.start();
		}))({
		target: input.target,
		workspaceRoot: input.workspaceRoot,
		ttyPath,
		claimId: claim.claimId,
		secret: claim.secret,
		broker,
	});

	return {
		mode: "mounted" as const,
		claim,
		ttyPath,
	};
}
