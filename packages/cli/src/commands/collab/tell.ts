import { createBrokerRuntime } from "@ai-whisper/broker";
import type { CompanionProvider, WorkItem } from "@ai-whisper/shared";
import { normalizeArtifactPaths } from "../../runtime/artifact-input.js";
import { getBrokerSqlitePath, getStateFilePath } from "../../runtime/paths.js";
import { readCliCollabState } from "../../runtime/state-file.js";
import { probeAndLatchBrokerState } from "../../runtime/recovery-guard.js";
import { processOneTurn } from "../../runtime/on-demand-processing.js";
import { enqueueRelayWork } from "../../runtime/relay-service.js";
import { waitForReply } from "../../runtime/reply-wait.js";
import { assessBrokerDaemon } from "../../runtime/broker-daemon.js";

export async function runCollabTell(input: {
	workspaceRoot: string;
	target: "codex" | "claude";
	instruction: string;
	explicitAction?: WorkItem["requestedAction"];
	artifactPaths: string[];
	threadTitle?: string;
	providerOverride?: CompanionProvider;
	now: string;
	assessBroker?: typeof assessBrokerDaemon;
}) {
	if (input.target !== "codex" && input.target !== "claude") {
		throw new Error(
			`Invalid target "${String(input.target)}". Must be "codex" or "claude".`,
		);
	}

	const state = readCliCollabState(getStateFilePath(input.workspaceRoot));
	if (!state) {
		throw new Error("No active collab. Run `whisper collab start` first.");
	}

	await probeAndLatchBrokerState(state, input.workspaceRoot, input.assessBroker);

	const broker = createBrokerRuntime({
		sqlitePath: getBrokerSqlitePath(input.workspaceRoot),
		host: state.broker.host,
		port: state.broker.port,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
	});

	const artifactPaths = normalizeArtifactPaths(
		input.workspaceRoot,
		input.artifactPaths,
	);

	const senderRole = input.target === "codex" ? "claude" : "codex";
	const senderSessionId = broker.control.resolveBoundSession(
		state.collabId,
		senderRole,
	);

	const relay = enqueueRelayWork({
		broker,
		collabId: state.collabId,
		originSessionId: senderSessionId,
		target: input.target,
		instruction: input.instruction,
		artifactPaths,
		forceNewThread: false,
		now: input.now,
		explicitAction: input.explicitAction,
		threadTitle: input.threadTitle,
	});

	const reply = input.providerOverride
		? await processOneTurn({
				broker,
				collabId: state.collabId,
				sessionId: relay.targetSessionId,
				provider: input.providerOverride,
				now: input.now,
			})
		: await waitForReply({
				broker,
				threadId: relay.thread.threadId,
				workItemId: relay.workItem.workItemId,
			});

	await broker.stop();
	return reply;
}
