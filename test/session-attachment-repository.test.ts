import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	upsertSessionAttachment,
	listSessionAttachmentsByCollab,
	deleteSessionAttachment,
} from "../packages/broker/src/storage/repositories/session-attachment-repository.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "sa-"));
	const db = openDatabase(join(dir, "broker.sqlite"));
	applyMigrations(db);
	db.prepare(
		"INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at) VALUES ('c1', '/r', 'a', 'active', '2026-05-15T00:00:00Z', '2026-05-15T00:00:00Z')",
	).run();
	return db;
}

describe("session-attachment-repository", () => {
	it("inserts and lists by collab", () => {
		const db = freshDb();
		upsertSessionAttachment(db, {
			collabId: "c1",
			agentType: "codex",
			attachmentKind: "owned",
			sessionId: "s1",
			providerId: "codex",
			launchMode: "tmux",
			ttyPath: null,
			pid: 100,
			windowLabel: "codex",
			attachedAt: "2026-05-15T00:00:00Z",
		});
		const rows = listSessionAttachmentsByCollab(db, "c1");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.agentType).toBe("codex");
		expect(rows[0]?.attachmentKind).toBe("owned");
	});

	it("allows the same agent under different attachment_kinds", () => {
		const db = freshDb();
		upsertSessionAttachment(db, {
			collabId: "c1",
			agentType: "codex",
			attachmentKind: "owned",
			sessionId: "s1",
			providerId: "codex",
			launchMode: "tmux",
			ttyPath: null,
			pid: 100,
			windowLabel: null,
			attachedAt: "2026-05-15T00:00:00Z",
		});
		upsertSessionAttachment(db, {
			collabId: "c1",
			agentType: "codex",
			attachmentKind: "mounted",
			sessionId: null,
			providerId: null,
			launchMode: null,
			ttyPath: "/dev/ttys001",
			pid: 100,
			windowLabel: null,
			attachedAt: "2026-05-15T00:00:01Z",
		});
		expect(listSessionAttachmentsByCollab(db, "c1")).toHaveLength(2);
	});

	it("upserts on conflict instead of throwing", () => {
		const db = freshDb();
		upsertSessionAttachment(db, {
			collabId: "c1",
			agentType: "codex",
			attachmentKind: "owned",
			sessionId: "s1",
			providerId: "codex",
			launchMode: "tmux",
			ttyPath: null,
			pid: 100,
			windowLabel: null,
			attachedAt: "2026-05-15T00:00:00Z",
		});
		upsertSessionAttachment(db, {
			collabId: "c1",
			agentType: "codex",
			attachmentKind: "owned",
			sessionId: "s2",
			providerId: "codex",
			launchMode: "tmux",
			ttyPath: null,
			pid: 200,
			windowLabel: null,
			attachedAt: "2026-05-15T00:00:05Z",
		});
		const rows = listSessionAttachmentsByCollab(db, "c1");
		expect(rows).toHaveLength(1);
		expect(rows[0]?.sessionId).toBe("s2");
		expect(rows[0]?.pid).toBe(200);
	});

	it("deletes by primary-key tuple", () => {
		const db = freshDb();
		upsertSessionAttachment(db, {
			collabId: "c1",
			agentType: "codex",
			attachmentKind: "owned",
			sessionId: "s1",
			providerId: "codex",
			launchMode: "tmux",
			ttyPath: null,
			pid: 100,
			windowLabel: null,
			attachedAt: "2026-05-15T00:00:00Z",
		});
		expect(
			deleteSessionAttachment(db, { collabId: "c1", agentType: "codex", attachmentKind: "owned" }),
		).toBe(1);
		expect(listSessionAttachmentsByCollab(db, "c1")).toHaveLength(0);
	});
});
