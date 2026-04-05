import { z } from "zod";
import { collabIdSchema } from "./id.js";
import { agentTypes } from "./literals.js";
import { brokerSchemaVersion } from "./version.js";

export const attachClaimSchema = z.object({
	version: z.literal(brokerSchemaVersion),
	claimId: z.string().min(1),
	collabId: collabIdSchema,
	agentType: z.enum(agentTypes),
	mode: z.enum(["attach", "rebind"]),
	secret: z.string().min(1),
	status: z.enum(["pending", "consumed", "expired", "replaced"]),
	createdAt: z.string().datetime({ offset: true }),
	expiresAt: z.string().datetime({ offset: true }),
	consumedAt: z.string().datetime({ offset: true }).nullable(),
});
export type AttachClaim = z.infer<typeof attachClaimSchema>;
