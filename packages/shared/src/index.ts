export const sharedPackageName = "@ai-whisper/shared";

export { brokerSchemaVersion } from "./version.js";
export type { Brand } from "./brand.js";
export {
  collabIdSchema,
  createCollabId,
  createEventId,
  createWorkItemId,
  eventIdSchema,
  workItemIdSchema,
} from "./id.js";
export {
  brokerHealthStates,
  eventTypes,
  threadStates,
} from "./literals.js";
export { brokerStatusSchema, type BrokerStatus } from "./broker-status.js";
export { eventEnvelopeSchema, type EventEnvelope } from "./event-envelope.js";
export {
  endpointHealthStates,
  type EndpointHealthState,
} from "./endpoint-health.js";
export {
  createProviderIdentity,
  type ProviderIdentity,
} from "./provider-identity.js";
