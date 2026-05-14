import { createBrokerRuntime } from "@ai-whisper/broker";
import { readCliCollabState } from "../../runtime/state-file.js";
import { getStateFilePath } from "../../runtime/paths.js";
import { probeAndLatchBrokerState } from "../../runtime/recovery-guard.js";
import { assessBrokerDaemon } from "../../runtime/broker-daemon.js";
import { resolveCurrentTty } from "../../runtime/current-tty.js";
import { createMountSessionRuntime } from "../../runtime/mount-session-main.js";

const MONITOR_WAIT_TIMEOUT_MS = 10_000;
const MONITOR_POLL_INTERVAL_MS = 250;

export async function runCollabMount(input: {
	workspaceRoot: string;
	target: "codex" | "claude";
	now: string;
	resolveCurrentTty?: () => string;
	createRuntime?: typeof createMountSessionRuntime;
	assessBroker?: typeof assessBrokerDaemon;
	sleep?: (ms: number) => Promise<void>;
	monitorWaitTimeoutMs?: number;
	monitorPollIntervalMs?: number;
}) {
	const sleep =
		input.sleep ??
		((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
	const monitorWaitTimeoutMs =
		input.monitorWaitTimeoutMs ?? MONITOR_WAIT_TIMEOUT_MS;
	const monitorPollIntervalMs =
		input.monitorPollIntervalMs ?? MONITOR_POLL_INTERVAL_MS;

	const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
	if (!state) {
		throw new Error("No active collab. Run `whisper collab start` first.");
	}

	await probeAndLatchBrokerState(state, input.workspaceRoot, input.assessBroker);
	const ttyPath = (input.resolveCurrentTty ?? resolveCurrentTty)();
	const broker = createBrokerRuntime({
		sqlitePath: state.broker.sqlitePath,
		host: state.broker.host,
		port: state.broker.port,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
	});
	let brokerHandedOff = false;
	try {
		let elapsed = 0;
		while (!broker.control.isRelayMonitorConnected(state.collabId)) {
			if (elapsed >= monitorWaitTimeoutMs) {
				throw new Error(
					"Relay monitor not connected. Run `whisper collab relay-monitor` in a separate terminal first.",
				);
			}
			await sleep(monitorPollIntervalMs);
			elapsed += monitorPollIntervalMs;
		}

		const current = broker.control
			.listSessionBindings(state.collabId)
			.find((binding) => binding.agentType === input.target);
		if (current?.bindingState === "bound") {
			throw new Error(
				`${input.target === "codex" ? "Codex" : "Claude"} is already bound. Stop the existing mount tab and run \`whisper collab mount\` again.`,
			);
		}

		const claim = broker.control.issueAttachClaim({
			collabId: state.collabId,
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
