import { createBrokerRuntime } from "@ai-whisper/broker";
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
		return {
			active: true as const,
			collabId: state.collabId,
			workspaceRoot: state.workspaceRoot,
			recovery: {
				state: "recovery_required" as const,
				idleAfterRecovery: state.recovery.idleAfterRecovery,
			},
			brokerHealth: { ok: false as const },
			roles: {
				codex: { agentType: "codex" as const, bindingState: "unbound" as const },
				claude: { agentType: "claude" as const, bindingState: "unbound" as const },
			},
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
	const codexBinding = bindings.find((b) => b.agentType === "codex");
	const claudeBinding = bindings.find((b) => b.agentType === "claude");

	await broker.stop();

	return {
		active: true as const,
		collabId: state.collabId,
		workspaceRoot: state.workspaceRoot,
		brokerHealth,
		roles: {
			codex: codexBinding ?? { agentType: "codex" as const, bindingState: "unbound" as const },
			claude: claudeBinding ?? { agentType: "claude" as const, bindingState: "unbound" as const },
		},
		activeThread: activeThread
			? { threadId: activeThread.threadId, title: activeThread.title }
			: null,
	};
}
