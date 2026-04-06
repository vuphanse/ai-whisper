import { z } from "zod";
import { collabIdSchema } from "./id.js";
import { agentTypes, attachTargetModes } from "./literals.js";
import { brokerSchemaVersion } from "./version.js";

export const attachClaimSchema = z.object({
	version: z.literal(brokerSchemaVersion),
	claimId: z.string().min(1),
	collabId: collabIdSchema,
	agentType: z.enum(agentTypes),
	mode: z.enum(["attach", "rebind", "reconnect"]),
	targetMode: z.enum(attachTargetModes).default("snippet_shell"),
	targetTtyPath: z.string().nullable().default(null),
	secret: z.string().min(1),
	status: z.enum(["pending", "consumed", "expired", "replaced"]),
	createdAt: z.string().datetime({ offset: true }),
	expiresAt: z.string().datetime({ offset: true }),
	consumedAt: z.string().datetime({ offset: true }).nullable(),
});
export type AttachClaim = z.infer<typeof attachClaimSchema>;
