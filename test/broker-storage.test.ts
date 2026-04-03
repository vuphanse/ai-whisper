import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { getBrokerState } from "../packages/broker/src/storage/repositories/broker-state-repository.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

describe("broker storage bootstrap", () => {
  it("creates broker state and event log tables", () => {
    const dir = mkdtempSync(join(tmpdir(), "ai-whisper-phase2-"));
    const db = openDatabase(join(dir, "broker.sqlite"));

    applyMigrations(db);

    expect(getBrokerState(db)).toEqual({
      schemaVersion: 1,
      migrated: true,
    });

    const eventLogTable = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'event_log'",
      )
      .get() as { name: string } | undefined;

    expect(eventLogTable?.name).toBe("event_log");
  });
});
