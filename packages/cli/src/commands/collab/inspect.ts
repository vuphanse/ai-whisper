import { createBrokerRuntime } from "@ai-whisper/broker";
import { assessBrokerDaemon } from "../../runtime/broker-daemon.js";
import { buildInspectSnapshot, formatInspectSnapshot } from "../../runtime/operator-inspect.js";
import { formatCapturesView } from "../../runtime/operator-inspect-captures.js";
import { formatVerdictsView } from "../../runtime/operator-inspect-verdicts.js";
import { getStateFilePath } from "../../runtime/paths.js";
import { readCliCollabState, writeCliCollabState } from "../../runtime/state-file.js";

// `true`     → list last 20 rows for the active collab
// `"all"`    → list all rows for the active collab (no limit)
// any string → list rows for that chain id
export type CapturesArg = true | string;
export type VerdictsArg = true | string;

const DEFAULT_LIMIT = 20;
const NO_LIMIT = null;

export async function runCollabInspect(input: {
	workspaceRoot: string;
	now: string;
	watch: boolean;
	captures?: CapturesArg;
	verdicts?: VerdictsArg;
	assessBroker?: typeof assessBrokerDaemon;
	write?: (chunk: string) => void;
	sleep?: (ms: number) => Promise<void>;
	watchIntervalMs?: number;
}) {
	if (input.captures !== undefined && input.verdicts !== undefined) {
		throw new Error("--captures and --verdicts are mutually exclusive.");
	}

	const renderOnce = async (timestamp: string) => {
		const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
		if (!state) {
			throw new Error("No active collab. Run `whisper collab start` first.");
		}

		const health = await (input.assessBroker ?? assessBrokerDaemon)({
			host: state.broker.host,
			port: state.broker.port,
			pid: state.broker.pid,
		});

		if (!health.ok) {
			if (state.recovery.state === "normal") {
				writeCliCollabState(getStateFilePath(input.workspaceRoot), {
					...state,
					recovery: {
						state: "recovery_required",
						idleAfterRecovery: state.recovery.idleAfterRecovery,
						recoveredAt: state.recovery.recoveredAt,
					},
				});
			}
			throw new Error("Broker is unavailable for the current collab. Run `whisper collab recover`.");
		}

		const broker = createBrokerRuntime({
			sqlitePath: state.broker.sqlitePath,
			host: state.broker.host,
			port: state.broker.port,
			runWorkflowDriver: false,
			runDiagnosticsSweep: false,
		});

		try {
			if (input.captures !== undefined) {
				const captures = input.captures;
				if (captures === true) {
					const rows = broker.control.listCaptureDiagnosticsByCollab(state.collabId, DEFAULT_LIMIT);
					return formatCapturesView({ rows, collabId: state.collabId });
				}
				if (captures === "all") {
					const rows = broker.control.listCaptureDiagnosticsByCollab(state.collabId, NO_LIMIT);
					return formatCapturesView({ rows, collabId: state.collabId });
				}
				// Treat any other string as a chain id, scoped to the active collab so
				// rows from other collabs sharing the chain id never leak through.
				const rows = broker.control.listCaptureDiagnosticsByCollabAndChain(
					state.collabId,
					captures,
					NO_LIMIT,
				);
				return formatCapturesView({ rows, collabId: state.collabId });
			}
			if (input.verdicts !== undefined) {
				const verdicts = input.verdicts;
				if (verdicts === true) {
					const rows = broker.control.listEvaluatorDiagnosticsByCollab(state.collabId, DEFAULT_LIMIT);
					return formatVerdictsView({ rows, collabId: state.collabId });
				}
				if (verdicts === "all") {
					const rows = broker.control.listEvaluatorDiagnosticsByCollab(state.collabId, NO_LIMIT);
					return formatVerdictsView({ rows, collabId: state.collabId });
				}
				const rows = broker.control.listEvaluatorDiagnosticsByCollabAndChain(
					state.collabId,
					verdicts,
					NO_LIMIT,
				);
				return formatVerdictsView({ rows, collabId: state.collabId });
			}
			const snapshot = buildInspectSnapshot({ broker, state, now: timestamp });
			return formatInspectSnapshot({
				...snapshot,
				watch: input.watch,
				brokerHealth: health.ok ? "ok" : "degraded",
			});
		} finally {
			await broker.stop();
		}
	};

	function clearScreen(): string {
		return "c";
	}

	const write = input.write ?? ((chunk: string) => process.stdout.write(chunk));
	const sleep =
		input.sleep ??
		((ms: number) =>
			new Promise<void>((resolve) => {
				setTimeout(resolve, ms);
			}));

	if (!input.watch) {
		return renderOnce(input.now);
	}

	let stopped = false;
	const stop = () => {
		stopped = true;
	};
	process.once("SIGINT", stop);
	process.once("SIGTERM", stop);

	try {
		while (!stopped) {
			const output = await renderOnce(new Date().toISOString());
			write(`${clearScreen()}${output}`);
			await sleep(input.watchIntervalMs ?? 1000);
		}
		return null;
	} finally {
		process.off("SIGINT", stop);
		process.off("SIGTERM", stop);
	}
}
