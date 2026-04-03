import { z } from "zod";
import { collabIdSchema, sessionIdSchema } from "./id.js";
import { endpointHealthStates } from "./endpoint-health.js";
import { providerCapabilitiesSchema } from "./provider-capabilities.js";
import { providerIdentitySchema } from "./provider-identity.js";
import { brokerSchemaVersion } from "./version.js";

export const companionRegistrationSchema = z.object({
  version: z.literal(brokerSchemaVersion),
  collabId: collabIdSchema,
  sessionId: sessionIdSchema,
  provider: providerIdentitySchema,
  capabilities: providerCapabilitiesSchema,
  registeredAt: z.string().datetime({ offset: true }),
});

export const companionRegistrationAckSchema = z.object({
  version: z.literal(brokerSchemaVersion),
  collabId: collabIdSchema,
  sessionId: sessionIdSchema,
  sessionSecret: z.string().min(16),
  acceptedAt: z.string().datetime({ offset: true }),
});

export const companionHeartbeatSchema = z.object({
  version: z.literal(brokerSchemaVersion),
  collabId: collabIdSchema,
  sessionId: sessionIdSchema,
  healthState: z.enum(endpointHealthStates),
  sentAt: z.string().datetime({ offset: true }),
});

export type CompanionRegistration = z.infer<typeof companionRegistrationSchema>;
export type CompanionRegistrationAck = z.infer<typeof companionRegistrationAckSchema>;
export type CompanionHeartbeat = z.infer<typeof companionHeartbeatSchema>;
