import { createBrokerRuntime } from "@ai-whisper/broker";
import type { SessionBinding } from "@ai-whisper/shared";
import { assessBrokerDaemon } from "../../runtime/broker-daemon.js";
import { getBrokerSqlitePath, getStateFilePath } from "../../runtime/paths.js";
import { readCliCollabState } from "../../runtime/state-file.js";

export async function runCollabStatus(input: {
	workspaceRoot: string;
	assessBroker?: typeof assessBrokerDaemon;
}) {
	const state = readCliCollabState(getStateFilePath(input.workspaceRoot));

	if (!state) {
		return { active: false as const, message: "No active collab." };
	}

	const brokerAssess = await (input.assessBroker ?? assessBrokerDaemon)({
		host: state.broker.host,
		port: state.broker.port,
		pid: state.broker.pid,
	});

	if (!brokerAssess.ok) {
		// Read last-known bindings from SQLite (accessible without daemon)
		let lastKnownRoles: {
			codex: SessionBinding | { agentType: "codex"; bindingState: "unbound" };
			claude: SessionBinding | { agentType: "claude"; bindingState: "unbound" };
		};
		try {
			const offlineBroker = createBrokerRuntime({
				sqlitePath: state.broker.sqlitePath,
				host: state.broker.host,
				port: state.broker.port,
			});
			const bindings = offlineBroker.control.listSessionBindings(state.collabId);
			const codexBinding = bindings.find((b) => b.agentType === "codex");
			const claudeBinding = bindings.find((b) => b.agentType === "claude");
			void offlineBroker.stop();
			lastKnownRoles = {
				codex: codexBinding ?? { agentType: "codex" as const, bindingState: "unbound" as const },
				claude: claudeBinding ?? { agentType: "claude" as const, bindingState: "unbound" as const },
			};
		} catch {
			lastKnownRoles = {
				codex: { agentType: "codex" as const, bindingState: "unbound" as const },
				claude: { agentType: "claude" as const, bindingState: "unbound" as const },
			};
		}
		return {
			active: true as const,
			collabId: state.collabId,
			workspaceRoot: state.workspaceRoot,
			recovery: {
				state: "recovery_required" as const,
				idleAfterRecovery: state.recovery.idleAfterRecovery,
			},
			brokerHealth: { ok: false as const },
			roles: lastKnownRoles,
			activeThread: null,
		};
	}

	let broker;
	try {
		broker = createBrokerRuntime({
			sqlitePath: getBrokerSqlitePath(input.workspaceRoot),
			host: state.broker.host,
			port: state.broker.port,
		});
	} catch {
		return {
			active: false as const,
			message: "Broker database is unavailable.",
		};
	}

	const threads = broker.control.listThreads(state.collabId);
	const activeThread = threads.find((t) => t.active) ?? null;
	const brokerHealth = broker.getHealth();

	const bindings = broker.control.listSessionBindings(state.collabId);
	const sessions = broker.control.listSessions(state.collabId);
	const codexBinding = bindings.find((b) => b.agentType === "codex");
	const claudeBinding = bindings.find((b) => b.agentType === "claude");

	await broker.stop();

	function enrichBinding(
		binding: SessionBinding | undefined,
		agentType: "codex" | "claude",
	): (SessionBinding & { healthState: string | null }) | { agentType: "codex" | "claude"; bindingState: "unbound"; healthState: null } {
		if (!binding) {
			return { agentType, bindingState: "unbound" as const, healthState: null };
		}
		const session = binding.activeSessionId
			? sessions.find((s) => s.sessionId === binding.activeSessionId)
			: null;
		return {
			...binding,
			healthState: session?.healthState ?? null,
		};
	}

	return {
		active: true as const,
		collabId: state.collabId,
		workspaceRoot: state.workspaceRoot,
		recovery: state.recovery,
		brokerHealth,
		roles: {
			codex: enrichBinding(codexBinding, "codex"),
			claude: enrichBinding(claudeBinding, "claude"),
		},
		idleAfterRecovery: state.recovery.idleAfterRecovery,
		activeThread: activeThread
			? { threadId: activeThread.threadId, title: activeThread.title }
			: null,
	};
}
