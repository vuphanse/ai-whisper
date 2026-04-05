import type Database from "better-sqlite3";

const initMigrationSql = `
CREATE TABLE IF NOT EXISTS broker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  migrated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS collab (
  collab_id TEXT PRIMARY KEY,
  workspace_root TEXT NOT NULL,
  display_name TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS session (
  session_id TEXT PRIMARY KEY,
  collab_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  registration_state TEXT NOT NULL,
  health_state TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  registered_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS thread (
  thread_id TEXT PRIMARY KEY,
  collab_id TEXT NOT NULL,
  title TEXT NOT NULL,
  thread_state TEXT NOT NULL,
  base_context_ref TEXT,
  current_turn_index INTEGER NOT NULL,
  active INTEGER NOT NULL,
  created_by_session_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_item (
  work_item_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  collab_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  sender_session_id TEXT NOT NULL,
  target_session_id TEXT NOT NULL,
  requested_action TEXT NOT NULL,
  instruction TEXT NOT NULL,
  context_packet_json TEXT NOT NULL,
  delivery_state TEXT NOT NULL,
  artifact_manifest_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS reply (
  reply_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  collab_id TEXT NOT NULL,
  work_item_id TEXT NOT NULL,
  source_session_id TEXT NOT NULL,
  turn_index INTEGER NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  transition_intent TEXT,
  artifact_manifest_ids_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_manifest (
  artifact_manifest_id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL,
  collab_id TEXT NOT NULL,
  produced_by_session_id TEXT NOT NULL,
  artifact_category TEXT NOT NULL,
  entries_json TEXT NOT NULL,
  summary TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifact_attachment (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collab_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  artifact_manifest_id TEXT NOT NULL,
  owner_type TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  attached_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS companion_session (
  collab_id TEXT NOT NULL,
  session_id TEXT NOT NULL,
  provider_json TEXT NOT NULL,
  capabilities_json TEXT NOT NULL,
  session_secret TEXT NOT NULL,
  health_state TEXT NOT NULL DEFAULT 'healthy',
  registered_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL,
  PRIMARY KEY (collab_id, session_id)
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  schema_version INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  collab_id TEXT NOT NULL,
  workspace_root TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS attach_claim (
  claim_id TEXT PRIMARY KEY,
  collab_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  mode TEXT NOT NULL,
  secret TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  consumed_at TEXT
);

CREATE TABLE IF NOT EXISTS session_binding (
  collab_id TEXT NOT NULL,
  agent_type TEXT NOT NULL,
  binding_state TEXT NOT NULL,
  active_session_id TEXT,
  binding_source TEXT,
  pending_claim_id TEXT,
  pending_claim_expires_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (collab_id, agent_type)
);

INSERT INTO broker_state (id, schema_version, migrated)
VALUES (1, 1, 1)
ON CONFLICT(id) DO UPDATE SET
  schema_version = excluded.schema_version,
  migrated = excluded.migrated;
`;

export function applyMigrations(db: Database.Database): void {
	db.exec(initMigrationSql);
}
