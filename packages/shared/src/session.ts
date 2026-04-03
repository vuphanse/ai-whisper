import { z } from "zod";
import { collabIdSchema, sessionIdSchema } from "./id.js";
import {
	agentTypes,
	brokerHealthStates,
	sessionRegistrationStates,
} from "./literals.js";
import { brokerSchemaVersion } from "./version.js";

export const sessionSchema = z.object({
	version: z.literal(brokerSchemaVersion),
	sessionId: sessionIdSchema,
	collabId: collabIdSchema,
	agentType: z.enum(agentTypes),
	registrationState: z.enum(sessionRegistrationStates),
	healthState: z.enum(brokerHealthStates),
	capabilities: z.record(z.string(), z.boolean()),
	registeredAt: z.string().datetime({ offset: true }),
	lastSeenAt: z.string().datetime({ offset: true }),
});

export type Session = z.infer<typeof sessionSchema>;
