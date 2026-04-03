import { z } from "zod";
import { collabIdSchema, sessionIdSchema, threadIdSchema } from "./id.js";
import { threadStates } from "./literals.js";
import { brokerSchemaVersion } from "./version.js";

export const threadSchema = z.object({
  version: z.literal(brokerSchemaVersion),
  threadId: threadIdSchema,
  collabId: collabIdSchema,
  title: z.string().min(1),
  threadState: z.enum(threadStates),
  baseContextRef: z.string().min(1).nullable(),
  currentTurnIndex: z.number().int().nonnegative(),
  active: z.boolean(),
  createdBySessionId: sessionIdSchema,
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Thread = z.infer<typeof threadSchema>;
