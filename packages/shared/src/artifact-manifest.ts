import { z } from "zod";
import {
	artifactManifestIdSchema,
	collabIdSchema,
	sessionIdSchema,
	threadIdSchema,
} from "./id.js";
import { artifactCategories } from "./literals.js";
import { brokerSchemaVersion } from "./version.js";

export const artifactEntrySchema = z.object({
	path: z.string().min(1),
	kind: z.enum(["file", "diff"]),
});

export const artifactManifestSchema = z.object({
	version: z.literal(brokerSchemaVersion),
	artifactManifestId: artifactManifestIdSchema,
	threadId: threadIdSchema,
	collabId: collabIdSchema,
	producedBySessionId: sessionIdSchema,
	artifactCategory: z.enum(artifactCategories),
	entries: z.array(artifactEntrySchema),
	summary: z.string().min(1),
	createdAt: z.string().datetime({ offset: true }),
});

export type ArtifactManifest = z.infer<typeof artifactManifestSchema>;
