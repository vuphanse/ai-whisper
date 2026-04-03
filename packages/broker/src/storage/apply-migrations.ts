import type Database from "better-sqlite3";

const initMigrationSql = `
CREATE TABLE IF NOT EXISTS broker_state (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  schema_version INTEGER NOT NULL,
  migrated INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS event_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
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
