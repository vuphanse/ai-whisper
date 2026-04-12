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
  updated_at TEXT NOT NULL,
  orchestrator_enabled INTEGER NOT NULL DEFAULT 0,
  orchestrator_max_rounds INTEGER NOT NULL DEFAULT 3
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
  consumed_by_json TEXT NOT NULL DEFAULT '[]',
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

CREATE TABLE IF NOT EXISTS relay_monitor (
  collab_id TEXT NOT NULL,
  monitor_id TEXT PRIMARY KEY,
  registered_at TEXT NOT NULL,
  last_heartbeat_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_event (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  collab_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  sender_agent TEXT,
  receiver_agent TEXT,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS work_item_cancellation (
  work_item_id TEXT PRIMARY KEY,
  requested_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS relay_turn_state (
  collab_id TEXT PRIMARY KEY,
  turn_owner TEXT NOT NULL,
  waiting_agent TEXT,
  unresolved_handoff_id TEXT,
  handoff_state TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  orchestrator_enabled INTEGER NOT NULL DEFAULT 0,
  current_round INTEGER NOT NULL DEFAULT 0,
  max_rounds INTEGER NOT NULL DEFAULT 3,
  chain_status TEXT NOT NULL DEFAULT 'done'
);

CREATE TABLE IF NOT EXISTS relay_handoff (
  handoff_id TEXT PRIMARY KEY,
  collab_id TEXT NOT NULL,
  sender_agent TEXT NOT NULL,
  target_agent TEXT NOT NULL,
  request_text TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  deferred_at TEXT,
  resolved_at TEXT,
  last_activity_at TEXT NOT NULL,
  capture_status TEXT,
  chain_id TEXT,
  parent_handoff_id TEXT,
  round_number INTEGER,
  root_request_text TEXT,
  handback_text TEXT,
  orchestrator_status TEXT,
  orchestrator_verdict TEXT,
  orchestrator_reason TEXT,
  orchestrator_claimed_at TEXT,
  orchestrator_evaluated_at TEXT
);

INSERT INTO broker_state (id, schema_version, migrated)
VALUES (1, 1, 1)
ON CONFLICT(id) DO UPDATE SET
  schema_version = excluded.schema_version,
  migrated = excluded.migrated;
`;

export function applyMigrations(db: Database.Database): void {
	db.exec(initMigrationSql);

	const attachClaimColumns = db
		.prepare("PRAGMA table_info(attach_claim)")
		.all() as Array<{ name: string }>;
	if (!attachClaimColumns.some((column) => column.name === "target_mode")) {
		db.exec("ALTER TABLE attach_claim ADD COLUMN target_mode TEXT");
	}
	if (!attachClaimColumns.some((column) => column.name === "target_tty_path")) {
		db.exec("ALTER TABLE attach_claim ADD COLUMN target_tty_path TEXT");
	}

	const bindingColumns = db
		.prepare("PRAGMA table_info(session_binding)")
		.all() as Array<{ name: string }>;
	if (!bindingColumns.some((column) => column.name === "target_tty_path")) {
		db.exec("ALTER TABLE session_binding ADD COLUMN target_tty_path TEXT");
	}

	const replyColumns = db
		.prepare("PRAGMA table_info(reply)")
		.all() as Array<{ name: string }>;
	if (!replyColumns.some((column) => column.name === "consumed_by_json")) {
		db.exec(
			"ALTER TABLE reply ADD COLUMN consumed_by_json TEXT NOT NULL DEFAULT '[]'",
		);
	}

	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'work_item_cancellation'",
		)
		.all() as Array<{ name: string }>;
	if (tables.length === 0) {
		db.exec(
			`CREATE TABLE work_item_cancellation (
				work_item_id TEXT PRIMARY KEY,
				requested_at TEXT NOT NULL
			)`,
		);
	}

	const relayHandoffColumns = db
		.prepare("PRAGMA table_info(relay_handoff)")
		.all() as Array<{ name: string }>;
	if (!relayHandoffColumns.some((col) => col.name === "capture_status")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN capture_status TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "chain_id")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN chain_id TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "parent_handoff_id")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN parent_handoff_id TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "round_number")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN round_number INTEGER");
	}
	if (!relayHandoffColumns.some((column) => column.name === "root_request_text")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN root_request_text TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "handback_text")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN handback_text TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "orchestrator_status")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN orchestrator_status TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "orchestrator_verdict")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN orchestrator_verdict TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "orchestrator_reason")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN orchestrator_reason TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "orchestrator_claimed_at")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN orchestrator_claimed_at TEXT");
	}
	if (!relayHandoffColumns.some((column) => column.name === "orchestrator_evaluated_at")) {
		db.exec("ALTER TABLE relay_handoff ADD COLUMN orchestrator_evaluated_at TEXT");
	}

	const collabColumns = db.prepare("PRAGMA table_info(collab)").all() as Array<{ name: string }>;
	if (!collabColumns.some((column) => column.name === "orchestrator_enabled")) {
		db.exec("ALTER TABLE collab ADD COLUMN orchestrator_enabled INTEGER NOT NULL DEFAULT 0");
	}
	if (!collabColumns.some((column) => column.name === "orchestrator_max_rounds")) {
		db.exec("ALTER TABLE collab ADD COLUMN orchestrator_max_rounds INTEGER NOT NULL DEFAULT 3");
	}

	const relayTurnStateColumns = db.prepare("PRAGMA table_info(relay_turn_state)").all() as Array<{ name: string }>;
	if (!relayTurnStateColumns.some((column) => column.name === "orchestrator_enabled")) {
		db.exec("ALTER TABLE relay_turn_state ADD COLUMN orchestrator_enabled INTEGER NOT NULL DEFAULT 0");
	}
	if (!relayTurnStateColumns.some((column) => column.name === "current_round")) {
		db.exec("ALTER TABLE relay_turn_state ADD COLUMN current_round INTEGER NOT NULL DEFAULT 0");
	}
	if (!relayTurnStateColumns.some((column) => column.name === "max_rounds")) {
		db.exec("ALTER TABLE relay_turn_state ADD COLUMN max_rounds INTEGER NOT NULL DEFAULT 3");
	}
	if (!relayTurnStateColumns.some((column) => column.name === "chain_status")) {
		db.exec("ALTER TABLE relay_turn_state ADD COLUMN chain_status TEXT NOT NULL DEFAULT 'done'");
	}
}
