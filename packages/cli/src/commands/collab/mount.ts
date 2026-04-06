import { createBrokerRuntime } from "@ai-whisper/broker";
import { readCliCollabState } from "../../runtime/state-file.js";
import { getStateFilePath } from "../../runtime/paths.js";
import { probeAndLatchBrokerState } from "../../runtime/recovery-guard.js";
import { assessBrokerDaemon } from "../../runtime/broker-daemon.js";
import { resolveCurrentTty } from "../../runtime/adopted-session-target.js";
import { createMountSessionRuntime } from "../../runtime/mount-session-main.js";

export async function runCollabMount(input: {
	workspaceRoot: string;
	target: "codex" | "claude";
	now: string;
	resolveCurrentTty?: () => string;
	createRuntime?: typeof createMountSessionRuntime;
	assessBroker?: typeof assessBrokerDaemon;
}) {
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
	});
	let brokerHandedOff = false;
	try {
		const current = broker.control
			.listSessionBindings(state.collabId)
			.find((binding) => binding.agentType === input.target);
		if (current?.bindingState === "bound") {
			throw new Error(
				`${input.target === "codex" ? "Codex" : "Claude"} is already bound. Use rebind for replacement.`,
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
