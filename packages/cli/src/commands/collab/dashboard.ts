import { randomBytes } from "node:crypto";
import { createBrokerRuntime } from "@ai-whisper/broker";
import { createDashboardRuntime } from "../../runtime/dashboard.js";
import { getSharedSqlitePath } from "../../runtime/state-root.js";

type BrokerLike = { stop: () => Promise<void> };
type RuntimeLike = {
	start: () => void;
	stop: () => Promise<void>;
	waitUntilStopped: () => Promise<void>;
};

export async function runCollabDashboard(input?: {
	stdout?: NodeJS.WritableStream;
	__createBroker?: () => BrokerLike;
	__createRuntime?: (
		broker: BrokerLike,
		dashboardId: string,
		stdout: NodeJS.WritableStream,
	) => RuntimeLike;
	__noSignals?: boolean;
}) {
	const stdout = input?.stdout ?? process.stdout;
	const sqlitePath = getSharedSqlitePath();
	const broker =
		input?.__createBroker?.() ??
		(createBrokerRuntime({
			sqlitePath,
			runWorkflowDriver: false,
			runDiagnosticsSweep: false,
			runDaemonHeartbeat: false,
			runBrokerDaemonSweep: false,
		}) as unknown as BrokerLike);

	const dashboardId = `dash_${randomBytes(9).toString("base64url")}`;
	const runtime =
		input?.__createRuntime?.(broker, dashboardId, stdout) ??
		(createDashboardRuntime({
			broker: broker as never,
			dashboardId,
			stdout,
		}) as unknown as RuntimeLike);

	let stoppedBySignal = false;
	if (!input?.__noSignals) {
		const onSig = () => {
			stoppedBySignal = true;
			runtime
				.stop()
				.then(() => broker.stop())
				.then(() => process.exit(0))
				.catch(() => process.exit(1));
		};
		process.on("SIGINT", onSig);
		process.on("SIGTERM", () => {
			const hard = setTimeout(() => process.exit(1), 3000);
			hard.unref();
			onSig();
		});
		process.on("uncaughtException", (err) => {
			const hard = setTimeout(() => process.exit(1), 3000);
			hard.unref();
			void runtime.stop().finally(() => {
				console.error(err);
				process.exit(1);
			});
		});
	}

	runtime.start();
	await runtime.waitUntilStopped();
	if (!stoppedBySignal) {
		await broker.stop();
	}
}
