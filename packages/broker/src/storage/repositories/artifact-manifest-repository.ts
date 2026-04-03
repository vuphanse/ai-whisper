import type Database from "better-sqlite3";
import {
	artifactManifestSchema,
	type ArtifactManifest,
} from "@ai-whisper/shared";

export function insertArtifactManifest(
	db: Database.Database,
	manifest: ArtifactManifest,
	attachment: { ownerType: string; ownerId: string; attachedAt: string },
): void {
	db.prepare(
		`INSERT INTO artifact_manifest (
      artifact_manifest_id,
      thread_id,
      collab_id,
      produced_by_session_id,
      artifact_category,
      entries_json,
      summary,
      created_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		manifest.artifactManifestId,
		manifest.threadId,
		manifest.collabId,
		manifest.producedBySessionId,
		manifest.artifactCategory,
		JSON.stringify(manifest.entries),
		manifest.summary,
		manifest.createdAt,
	);

	db.prepare(
		`INSERT INTO artifact_attachment (
      collab_id,
      thread_id,
      artifact_manifest_id,
      owner_type,
      owner_id,
      attached_at
    ) VALUES (?, ?, ?, ?, ?, ?)`,
	).run(
		manifest.collabId,
		manifest.threadId,
		manifest.artifactManifestId,
		attachment.ownerType,
		attachment.ownerId,
		attachment.attachedAt,
	);
}

export function getArtifactManifest(
	db: Database.Database,
	artifactManifestId: string,
): ArtifactManifest | null {
	const row = db
		.prepare(
			`SELECT artifact_manifest_id, thread_id, collab_id, produced_by_session_id, artifact_category, entries_json, summary, created_at
       FROM artifact_manifest
       WHERE artifact_manifest_id = ?`,
		)
		.get(artifactManifestId) as
		| {
				artifact_manifest_id: string;
				thread_id: string;
				collab_id: string;
				produced_by_session_id: string;
				artifact_category: string;
				entries_json: string;
				summary: string;
				created_at: string;
		  }
		| undefined;

	if (!row) {
		return null;
	}

	return artifactManifestSchema.parse({
		version: 1,
		artifactManifestId: row.artifact_manifest_id,
		threadId: row.thread_id,
		collabId: row.collab_id,
		producedBySessionId: row.produced_by_session_id,
		artifactCategory: row.artifact_category,
		entries: JSON.parse(row.entries_json) as Array<{
			path: string;
			kind: "file" | "diff";
		}>,
		summary: row.summary,
		createdAt: row.created_at,
	});
}

export function listArtifactManifestsForThread(
	db: Database.Database,
	threadId: string,
): ArtifactManifest[] {
	const rows = db
		.prepare(
			`SELECT artifact_manifest_id, thread_id, collab_id, produced_by_session_id, artifact_category, entries_json, summary, created_at
       FROM artifact_manifest
       WHERE thread_id = ?
       ORDER BY created_at ASC`,
		)
		.all(threadId) as Array<{
		artifact_manifest_id: string;
		thread_id: string;
		collab_id: string;
		produced_by_session_id: string;
		artifact_category: string;
		entries_json: string;
		summary: string;
		created_at: string;
	}>;

	return rows.map((row) =>
		artifactManifestSchema.parse({
			version: 1,
			artifactManifestId: row.artifact_manifest_id,
			threadId: row.thread_id,
			collabId: row.collab_id,
			producedBySessionId: row.produced_by_session_id,
			artifactCategory: row.artifact_category,
			entries: JSON.parse(row.entries_json) as Array<{
				path: string;
				kind: "file" | "diff";
			}>,
			summary: row.summary,
			createdAt: row.created_at,
		}),
	);
}

export function listArtifactAttachmentsForOwner(
	db: Database.Database,
	ownerType: string,
	ownerId: string,
): Array<{
	artifactManifestId: string;
	ownerType: string;
	ownerId: string;
	attachedAt: string;
}> {
	const rows = db
		.prepare(
			`SELECT artifact_manifest_id, owner_type, owner_id, attached_at
       FROM artifact_attachment
       WHERE owner_type = ? AND owner_id = ?
       ORDER BY attached_at ASC`,
		)
		.all(ownerType, ownerId) as Array<{
		artifact_manifest_id: string;
		owner_type: string;
		owner_id: string;
		attached_at: string;
	}>;

	return rows.map((row) => ({
		artifactManifestId: row.artifact_manifest_id,
		ownerType: row.owner_type,
		ownerId: row.owner_id,
		attachedAt: row.attached_at,
	}));
}
