import { z } from "zod";

export const brokerConfigSchema = z.object({
	sqlitePath: z.string().min(1),
	host: z.string().min(1).default("127.0.0.1"),
	port: z.number().int().positive().default(4311),
	// Only the authoritative broker (the daemon) should run the WorkflowDriver.
	// Transient CLI brokers that open this SQLite for one-shot control calls
	// must pass `false` — otherwise a setImmediate-scheduled phase kickoff
	// races broker.stop() and crashes on the closed database connection.
	runWorkflowDriver: z.boolean().default(true),
	// Same rationale as runWorkflowDriver: only the authoritative broker should
	// run the diagnostics-sweep timer. Transient CLI brokers (inspect, status,
	// etc.) must pass `false` so they do not spin up a per-process maintenance
	// timer that ticks until the next short-lived stop().
	runDiagnosticsSweep: z.boolean().default(true),
	// Same rationale as runWorkflowDriver / runDiagnosticsSweep: only the
	// authoritative broker daemon should tick the heartbeat for its collab.
	// Transient CLI brokers must pass `false` so their inspections do not
	// overwrite last_heartbeat_at for a collab they do not own.
	runDaemonHeartbeat: z.boolean().default(true),
	// Same rationale as runDaemonHeartbeat: only the authoritative broker
	// daemon should run the broker_daemon stale-row sweep. Transient CLI
	// brokers must pass `false` so their short-lived processes do not spin up
	// a maintenance timer that ticks until stop().
	runBrokerDaemonSweep: z.boolean().default(true),
});

export type BrokerConfig = z.input<typeof brokerConfigSchema>;
export type ParsedBrokerConfig = z.output<typeof brokerConfigSchema>;
