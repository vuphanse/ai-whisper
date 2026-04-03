import type Database from "better-sqlite3";

export function getBrokerState(db: Database.Database): {
  schemaVersion: number;
  migrated: boolean;
} {
  const row = db
    .prepare(
      "SELECT schema_version AS schemaVersion, migrated FROM broker_state WHERE id = 1",
    )
    .get() as { schemaVersion: number; migrated: number };

  return {
    schemaVersion: row.schemaVersion,
    migrated: row.migrated === 1,
  };
}
