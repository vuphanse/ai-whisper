import { z } from "zod";
import { collabIdSchema } from "./id.js";
import { collabStates } from "./literals.js";
import { brokerSchemaVersion } from "./version.js";

export const collabSchema = z.object({
  version: z.literal(brokerSchemaVersion),
  collabId: collabIdSchema,
  workspaceRoot: z.string().min(1),
  displayName: z.string().min(1),
  status: z.enum(collabStates),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }),
});

export type Collab = z.infer<typeof collabSchema>;
