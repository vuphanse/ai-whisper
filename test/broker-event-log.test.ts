import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createEventId } from "../packages/shared/src/index.ts";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import {
	appendEvent,
	listEventsForCollab,
} from "../packages/broker/src/storage/repositories/event-log-repository.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

describe("broker event log", () => {
	it("appends and reads collaboration-scoped events in order", () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-events-"));
		const db = openDatabase(join(dir, "broker.sqlite"));

		applyMigrations(db);

		appendEvent(db, {
			version: 1,
			eventId: createEventId("evt_first"),
			eventType: "collab.started",
			collabId: "collab_phase3",
			workspaceRoot: "/tmp/ai-whisper",
			timestamp: "2026-04-03T00:00:00.000Z",
			payload: { status: "started" },
		});

		appendEvent(db, {
			version: 1,
			eventId: createEventId("evt_second"),
			eventType: "thread.created",
			collabId: "collab_phase3",
			workspaceRoot: "/tmp/ai-whisper",
			timestamp: "2026-04-03T00:00:01.000Z",
			payload: { status: "created" },
		});

		expect(
			listEventsForCollab(db, "collab_phase3").map((event) => event.eventId),
		).toEqual(["evt_first", "evt_second"]);
	});
});
