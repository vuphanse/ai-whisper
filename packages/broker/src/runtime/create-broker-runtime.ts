import type Database from "better-sqlite3";
import type { FastifyInstance } from "fastify";
import { createControlService } from "../control/create-control-service.js";
import { createBrokerApp } from "../http/create-broker-app.js";
import { brokerConfigSchema, type BrokerConfig } from "../config.js";
import { applyMigrations } from "../storage/apply-migrations.js";
import { openDatabase } from "../storage/open-database.js";
import { getBrokerState } from "../storage/repositories/broker-state-repository.js";

export type BrokerRuntime = {
	app: FastifyInstance;
	config: BrokerConfig;
	db: Database.Database;
	control: ReturnType<typeof createControlService>;
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
	__getDbForTests(): Database.Database;
};

export function createBrokerRuntime(input: BrokerConfig): BrokerRuntime {
	const config = brokerConfigSchema.parse(input);
	const db = openDatabase(config.sqlitePath);

	applyMigrations(db);

	const control = createControlService(db);
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
		async start(): Promise<void> {
			await app.listen({
				host: config.host,
				port: config.port,
			});
		},
		async stop(): Promise<void> {
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
		__getDbForTests() {
			return db;
		},
	};
}
