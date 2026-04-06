import { z } from "zod";
import { agentTypes, bindingSources } from "./literals.js";
import { collabIdSchema, sessionIdSchema } from "./id.js";
import { brokerSchemaVersion } from "./version.js";

export const sessionBindingSchema = z.object({
	version: z.literal(brokerSchemaVersion),
	collabId: collabIdSchema,
	agentType: z.enum(agentTypes),
	bindingState: z.enum(["unbound", "pending_attach", "bound"]),
	activeSessionId: sessionIdSchema.nullable(),
	bindingSource: z.enum(bindingSources).nullable(),
	targetTtyPath: z.string().nullable().default(null),
	pendingClaimId: z.string().nullable(),
	pendingClaimExpiresAt: z.string().datetime({ offset: true }).nullable(),
	updatedAt: z.string().datetime({ offset: true }),
});
export type SessionBinding = z.infer<typeof sessionBindingSchema>;
