import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createControlService } from "../control/create-control-service.js";
import { createBrokerApp } from "../http/create-broker-app.js";
import { brokerConfigSchema, type BrokerConfig } from "../config.js";
import { applyMigrations } from "../storage/apply-migrations.js";
import { openDatabase } from "../storage/open-database.js";
import { getBrokerState } from "../storage/repositories/broker-state-repository.js";
import {
	createBrokerEventBus,
	type BrokerEventBus,
} from "./broker-event-bus.js";
import {
	defaultIsAlive,
	sweepStaleBrokerDaemons,
} from "./broker-daemon-sweep.js";
import { createDaemonHeartbeat } from "./daemon-heartbeat.js";
import { createDiagnosticsSweep } from "./diagnostics-sweep.js";
import { createWorkflowDriver } from "./workflow-driver.js";
import { createWorkspaceHeadReader } from "./workspace-head-reader.js";

export type BrokerRuntime = {
	app: FastifyInstance;
	config: BrokerConfig;
	db: Database.Database;
	control: ReturnType<typeof createControlService>;
	events: BrokerEventBus;
	start(): Promise<void>;
	stop(): Promise<void>;
	getHealth(): { readonly ok: true };
	getStatus(): {
		readonly version: 1;
		readonly status: "healthy";
		readonly storage: {
			readonly driver: "sqlite";
			readonly path: string;
			readonly migrated: boolean;
		};
	};
};

export function createBrokerRuntime(input: BrokerConfig): BrokerRuntime {
	const config = brokerConfigSchema.parse(input);
	const db = openDatabase(config.sqlitePath);

	applyMigrations(db);

	const events = createBrokerEventBus();
	const control = createControlService(db, events);
	const headReader = createWorkspaceHeadReader();
	const workflowDriver = config.runWorkflowDriver
		? createWorkflowDriver({
				broker: { control, events },
				headReader,
				sweepIntervalMs: 30_000,
			})
		: null;
	workflowDriver?.start();
	const diagnosticsSweep = config.runDiagnosticsSweep
		? createDiagnosticsSweep({ broker: { control } })
		: null;
	diagnosticsSweep?.start();
	const heartbeatCollabId = process.env.AI_WHISPER_DAEMON_COLLAB_ID;
	const heartbeat = config.runDaemonHeartbeat && heartbeatCollabId
		? createDaemonHeartbeat({
				db,
				collabId: heartbeatCollabId,
				intervalMs: Number(process.env.AI_WHISPER_HEARTBEAT_MS ?? 10_000),
				now: () => new Date().toISOString(),
			})
		: null;
	heartbeat?.start();
	const daemonSweepIntervalMs = Number(
		process.env.AI_WHISPER_DAEMON_SWEEP_MS ?? 60_000,
	);
	const daemonStaleMs = Number(
		process.env.AI_WHISPER_DAEMON_STALE_MS ?? 90_000,
	);
	let daemonSweepTimer: NodeJS.Timeout | null = null;
	if (config.runBrokerDaemonSweep) {
		daemonSweepTimer = setInterval(() => {
			const cutoff = new Date(Date.now() - daemonStaleMs).toISOString();
			void sweepStaleBrokerDaemons({
				db,
				cutoffIso: cutoff,
				isAlive: defaultIsAlive,
			});
		}, daemonSweepIntervalMs);
		daemonSweepTimer.unref();
	}
	const app = createBrokerApp({
		getStatus: () => ({
			version: 1 as const,
			status: "healthy" as const,
			storage: {
				driver: "sqlite" as const,
				path: config.sqlitePath,
				migrated: getBrokerState(db).migrated,
			},
		}),
	});

	return {
		app,
		config,
		db,
		control,
		events,
		async start(): Promise<void> {
			await app.listen({
				host: config.host,
				port: config.port,
			});
		},
		async stop(): Promise<void> {
			if (daemonSweepTimer) clearInterval(daemonSweepTimer);
			heartbeat?.stop();
			diagnosticsSweep?.stop();
			workflowDriver?.stop();
			await app.close();
			db.close();
		},
		getHealth() {
			return {
				ok: true,
			} as const;
		},
		getStatus() {
			return {
				version: 1 as const,
				status: "healthy" as const,
				storage: {
					driver: "sqlite" as const,
					path: config.sqlitePath,
					migrated: getBrokerState(db).migrated,
				},
			};
		},
	};
}
