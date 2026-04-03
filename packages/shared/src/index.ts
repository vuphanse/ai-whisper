export const sharedPackageName = "@ai-whisper/shared";

export { brokerSchemaVersion } from "./version.js";
export type { Brand } from "./brand.js";
export {
  artifactManifestIdSchema,
  collabIdSchema,
  createArtifactManifestId,
  createCollabId,
  createEventId,
  createReplyId,
  createSessionId,
  createThreadId,
  createWorkItemId,
  eventIdSchema,
  replyIdSchema,
  sessionIdSchema,
  threadIdSchema,
  workItemIdSchema,
} from "./id.js";
export {
  agentTypes,
  artifactCategories,
  brokerHealthStates,
  collabStates,
  eventTypes,
  replyKinds,
  requestedActions,
  sessionRegistrationStates,
  threadStates,
  transitionIntents,
  workItemStates,
} from "./literals.js";
export { brokerStatusSchema, type BrokerStatus } from "./broker-status.js";
export { collabSchema, type Collab } from "./collab.js";
export { sessionSchema, type Session } from "./session.js";
export { threadSchema, type Thread } from "./thread.js";
export {
  contextPacketSchema,
  deltaContextPacketSchema,
  fullContextPacketSchema,
  type DeltaContextPacket,
  type FullContextPacket,
  workItemSchema,
  type WorkItem,
} from "./work-item.js";
export { replySchema, type Reply } from "./reply.js";
export {
  artifactEntrySchema,
  artifactManifestSchema,
  type ArtifactManifest,
} from "./artifact-manifest.js";
export { eventEnvelopeSchema, type EventEnvelope } from "./event-envelope.js";
export {
  endpointHealthStates,
  type EndpointHealthState,
} from "./endpoint-health.js";
export {
  createProviderIdentity,
  type ProviderIdentity,
} from "./provider-identity.js";
