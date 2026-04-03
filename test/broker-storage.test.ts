import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { getBrokerState } from "../packages/broker/src/storage/repositories/broker-state-repository.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

describe("broker storage bootstrap", () => {
  it("creates broker state and the phase 3 collaboration tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-whisper-phase3-"));
    const db = openDatabase(join(dir, "broker.sqlite"));

    applyMigrations(db);

    expect(getBrokerState(db)).toEqual({
      schemaVersion: 1,
      migrated: true,
    });

    const eventLogColumns = db
      .prepare("PRAGMA table_info(event_log)")
      .all() as Array<{ name: string }>;

    expect(eventLogColumns.map((column) => column.name)).toEqual([
      "id",
      "event_id",
      "schema_version",
      "event_type",
      "collab_id",
      "workspace_root",
      "payload_json",
      "created_at",
    ]);
  });
});
