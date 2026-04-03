import { z } from "zod";
import { brokerSchemaVersion } from "./version.js";
import { brokerHealthStates } from "./literals.js";

export const brokerStatusSchema = z.object({
	version: z.literal(brokerSchemaVersion),
	status: z.enum(brokerHealthStates),
	storage: z.object({
		driver: z.literal("sqlite"),
		path: z.string().min(1),
		migrated: z.boolean(),
	}),
});

export type BrokerStatus = z.infer<typeof brokerStatusSchema>;
