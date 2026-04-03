import { z } from "zod";
import {
  artifactManifestIdSchema,
  collabIdSchema,
  replyIdSchema,
  sessionIdSchema,
  threadIdSchema,
  workItemIdSchema,
} from "./id.js";
import { replyKinds, transitionIntents } from "./literals.js";
import { brokerSchemaVersion } from "./version.js";

export const replySchema = z.object({
  version: z.literal(brokerSchemaVersion),
  replyId: replyIdSchema,
  threadId: threadIdSchema,
  collabId: collabIdSchema,
  workItemId: workItemIdSchema,
  sourceSessionId: sessionIdSchema,
  turnIndex: z.number().int().positive(),
  kind: z.enum(replyKinds),
  content: z.string().min(1),
  transitionIntent: z.enum(transitionIntents).nullable(),
  artifactManifestIds: z.array(artifactManifestIdSchema),
  createdAt: z.string().datetime({ offset: true }),
});

export type Reply = z.infer<typeof replySchema>;
