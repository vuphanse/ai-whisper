import type Database from "better-sqlite3";
import {
	companionHeartbeatSchema,
	companionRegistrationAckSchema,
} from "@ai-whisper/shared";

export function insertCompanionSession(
	db: Database.Database,
	input: {
		collabId: string;
		sessionId: string;
		providerJson: string;
		capabilitiesJson: string;
		sessionSecret: string;
		registeredAt: string;
	},
): void {
	db.prepare(
		`INSERT INTO companion_session (
      collab_id,
      session_id,
      provider_json,
      capabilities_json,
      session_secret,
      registered_at,
      last_heartbeat_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.collabId,
		input.sessionId,
		input.providerJson,
		input.capabilitiesJson,
		input.sessionSecret,
		input.registeredAt,
		input.registeredAt,
	);
}

export function getCompanionSession(
	db: Database.Database,
	collabId: string,
	sessionId: string,
): { sessionSecret: string } | null {
	const row = db
		.prepare(
			`SELECT session_secret
       FROM companion_session
       WHERE collab_id = ? AND session_id = ?`,
		)
		.get(collabId, sessionId) as { session_secret: string } | undefined;

	return row ? { sessionSecret: row.session_secret } : null;
}

export function updateCompanionHeartbeat(
	db: Database.Database,
	input: {
		collabId: string;
		sessionId: string;
		healthState: "healthy" | "degraded" | "offline";
		sentAt: string;
	},
): void {
	companionHeartbeatSchema.parse({
		version: 1,
		collabId: input.collabId,
		sessionId: input.sessionId,
		healthState: input.healthState,
		sentAt: input.sentAt,
	});

	db.prepare(
		`UPDATE companion_session
     SET health_state = ?, last_heartbeat_at = ?
     WHERE collab_id = ? AND session_id = ?`,
	).run(input.healthState, input.sentAt, input.collabId, input.sessionId);
}

export function deleteCompanionSessionsForCollab(db: Database.Database, collabId: string): void {
	db.prepare("DELETE FROM companion_session WHERE collab_id = ?").run(collabId);
}

export function createCompanionAck(input: {
	collabId: string;
	sessionId: string;
	sessionSecret: string;
	acceptedAt: string;
}) {
	return companionRegistrationAckSchema.parse({
		version: 1,
		collabId: input.collabId,
		sessionId: input.sessionId,
		sessionSecret: input.sessionSecret,
		acceptedAt: input.acceptedAt,
	});
}
