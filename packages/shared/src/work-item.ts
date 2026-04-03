import { z } from "zod";
import {
  artifactManifestIdSchema,
  collabIdSchema,
  sessionIdSchema,
  threadIdSchema,
  workItemIdSchema,
} from "./id.js";
import { requestedActions, workItemStates } from "./literals.js";
import { brokerSchemaVersion } from "./version.js";

export const fullContextPacketSchema = z.object({
  kind: z.literal("full"),
  goal: z.string().min(1),
  currentState: z.string().min(1),
  decisionsMade: z.array(z.string()),
  assumptions: z.array(z.string()),
  relevantArtifacts: z.array(z.string()),
  openQuestions: z.array(z.string()),
  successCriteria: z.array(z.string()),
});

export const deltaContextPacketSchema = z.object({
  kind: z.literal("delta"),
  baseContextRef: z.string().min(1),
  changedDecisions: z.array(z.string()),
  changedAssumptions: z.array(z.string()),
  newlyAttachedArtifacts: z.array(z.string()),
  contextNote: z.string().min(1).optional(),
});

export const contextPacketSchema = z.discriminatedUnion("kind", [
  fullContextPacketSchema,
  deltaContextPacketSchema,
]);

export const workItemSchema = z.object({
  version: z.literal(brokerSchemaVersion),
  workItemId: workItemIdSchema,
  threadId: threadIdSchema,
  collabId: collabIdSchema,
  turnIndex: z.number().int().positive(),
  senderSessionId: sessionIdSchema,
  targetSessionId: sessionIdSchema,
  requestedAction: z.enum(requestedActions),
  instruction: z.string().min(1),
  contextPacket: contextPacketSchema,
  deliveryState: z.enum(workItemStates),
  artifactManifestIds: z.array(artifactManifestIdSchema),
  createdAt: z.string().datetime({ offset: true }),
  deliveredAt: z.string().datetime({ offset: true }).nullable(),
  completedAt: z.string().datetime({ offset: true }).nullable(),
});

export type FullContextPacket = z.infer<typeof fullContextPacketSchema>;
export type DeltaContextPacket = z.infer<typeof deltaContextPacketSchema>;
export type WorkItem = z.infer<typeof workItemSchema>;
