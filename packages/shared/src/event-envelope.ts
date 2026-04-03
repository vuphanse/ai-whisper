import { z } from "zod";
import { brokerSchemaVersion } from "./version.js";
import { collabIdSchema, eventIdSchema } from "./id.js";
import { eventTypes } from "./literals.js";

export const eventEnvelopeSchema = z.object({
	version: z.literal(brokerSchemaVersion),
	eventId: eventIdSchema,
	eventType: z.enum(eventTypes),
	collabId: collabIdSchema,
	workspaceRoot: z.string().min(1),
	timestamp: z.string().datetime({ offset: true }),
	payload: z.object({
		status: z.string().min(1),
	}),
});

export type EventEnvelope = z.infer<typeof eventEnvelopeSchema>;
