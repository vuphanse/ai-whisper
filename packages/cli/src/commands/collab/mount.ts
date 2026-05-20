import {
	createBrokerRuntime,
	openDatabase,
	upsertSessionAttachment,
} from "@ai-whisper/broker";
import { assessBrokerDaemon } from "../../runtime/broker-daemon.js";
import { resolveCurrentTty } from "../../runtime/current-tty.js";
import { createMountSessionRuntime } from "../../runtime/mount-session-main.js";
import { resolveCollab } from "../../runtime/collab-resolver.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";

export function recordMountedSession(input: {
	cwd: string;
	agentType: "codex" | "claude";
	ttyPath: string;
	pid: number;
	collabIdOverride?: string;
}): void {
	const db = openDatabase(getSharedSqlitePath());
	try {
		const r = resolveCollab({
			db,
			cwd: input.cwd,
			...(input.collabIdOverride !== undefined
				? { collabIdOverride: input.collabIdOverride }
				: {}),
		});
		upsertSessionAttachment(db, {
			collabId: r.collabId,
			agentType: input.agentType,
			attachmentKind: "mounted",
			sessionId: null,
			providerId: null,
			launchMode: null,
			ttyPath: input.ttyPath,
			pid: input.pid,
			windowLabel: null,
			attachedAt: new Date().toISOString(),
		});
	} finally {
		db.close();
	}
}

export async function runCollabMount(input: {
	workspaceRoot: string;
	collabIdOverride?: string;
	target: "codex" | "claude";
	now: string;
	resolveCurrentTty?: () => string;
	createRuntime?: typeof createMountSessionRuntime;
	assessBroker?: typeof assessBrokerDaemon;
}) {
	const db = openDatabase(getSharedSqlitePath());
	let resolved;
	try {
		resolved = resolveCollab({
			db,
			cwd: input.workspaceRoot,
			...(input.collabIdOverride
				? { collabIdOverride: input.collabIdOverride }
				: {}),
			requireActive: true,
			requireDaemon: true,
		});
	} finally {
		db.close();
	}

	if (resolved.recovery.state === "recovery_required") {
		throw new Error(
			"Broker is unavailable for the current collab. Run `whisper collab recover`.",
		);
	}
	if (resolved.recovery.state === "recovered") {
		throw new Error(
			"Collab has been recovered and still needs reconnect. Run `whisper collab reconnect <codex|claude>`.",
		);
	}

	// daemon is non-null because requireDaemon: true.
	const daemon = resolved.daemon as { host: string; port: number; pid: number };

	// Optional broker probe (callers in tests inject a mock).
	if (input.assessBroker) {
		const health = await input.assessBroker({
			host: daemon.host,
			port: daemon.port,
			pid: daemon.pid,
		});
		if (!health.ok) {
			throw new Error(
				"Broker is unavailable for the current collab. Run `whisper collab recover`.",
			);
		}
	}

	const ttyPath = (input.resolveCurrentTty ?? resolveCurrentTty)();
	const broker = createBrokerRuntime({
		sqlitePath: getSharedSqlitePath(),
		host: daemon.host,
		port: daemon.port,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
	let brokerHandedOff = false;
	try {
		const current = broker.control
			.listSessionBindings(resolved.collabId)
			.find((binding) => binding.agentType === input.target);
		if (current?.bindingState === "bound") {
			throw new Error(
				`${input.target === "codex" ? "Codex" : "Claude"} is already bound. Stop the existing mount tab and run \`whisper collab mount\` again.`,
			);
		}

		const claim = broker.control.issueAttachClaim({
			collabId: resolved.collabId,
			agentType: input.target,
			mode: "attach",
			targetMode: "mount_current_tty",
			targetTtyPath: ttyPath,
			now: input.now,
			expiresAt: new Date(Date.parse(input.now) + 5 * 60_000).toISOString(),
		});

		const runtime = (input.createRuntime ?? createMountSessionRuntime)({
			target: input.target,
			ttyPath,
			workspaceRoot: input.workspaceRoot,
			claimId: claim.claimId,
			secret: claim.secret,
			broker,
		});

		brokerHandedOff = true;
		await runtime.start();
	} finally {
		if (!brokerHandedOff) {
			await broker.stop();
		}
	}
}
