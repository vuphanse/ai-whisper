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
});

export type BrokerConfig = z.input<typeof brokerConfigSchema>;
export type ParsedBrokerConfig = z.output<typeof brokerConfigSchema>;
