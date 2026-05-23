import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { applyMigrations } from "../packages/broker/src/storage/apply-migrations.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";
import {
	insertSession,
	listSessionsForCollab,
	reapSupersededSessions,
} from "../packages/broker/src/storage/repositories/session-repository.ts";
import type { Session } from "@ai-whisper/shared";
import {
	safeReapSessions,
	reapStaleSessionsOnMount,
	reapStaleSessionsOnTeardown,
} from "../packages/cli/src/runtime/mount-session-main.ts";

function freshDb() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-reap-"));
	const db = openDatabase(join(dir, "state.db"));
	applyMigrations(db);
	return db;
}

function mkSession(o: {
	id: string;
	collab: string;
	agent: "codex" | "claude";
	health?: "healthy" | "degraded" | "offline";
	at?: string;
}): Session {
	const at = o.at ?? "2026-05-20T00:00:00.000Z";
	return {
		version: 1,
		sessionId: o.id,
		collabId: o.collab,
		agentType: o.agent,
		registrationState: "registered",
		healthState: o.health ?? "healthy",
		capabilities: {},
		registeredAt: at,
		lastSeenAt: at,
	};
}

describe("reapSupersededSessions", () => {
	const cA = "collab_a";
	const cB = "collab_b";

	it("deletes superseded rows for (collab, agent), keeps the kept row, leaves others", () => {
		const db = freshDb();
		// (collab, agent) target: two stale + one keep
		insertSession(db, mkSession({ id: "session_stale1", collab: cA, agent: "codex" }));
		insertSession(db, mkSession({ id: "session_stale2", collab: cA, agent: "codex", health: "degraded" }));
		insertSession(db, mkSession({ id: "session_keep", collab: cA, agent: "codex" }));
		// different agent, same collab
		insertSession(db, mkSession({ id: "session_claudea", collab: cA, agent: "claude" }));
		// different collab
		insertSession(db, mkSession({ id: "session_codexb", collab: cB, agent: "codex" }));

		const deleted = reapSupersededSessions(db, cA, "codex", "session_keep");
		expect(deleted).toBe(2);

		const cAIds = listSessionsForCollab(db, cA).map((s) => s.sessionId).sort();
		expect(cAIds).toEqual(["session_claudea", "session_keep"]);
		const cBIds = listSessionsForCollab(db, cB).map((s) => s.sessionId);
		expect(cBIds).toEqual(["session_codexb"]);
	});

	it("is a no-op when only the kept row exists", () => {
		const db = freshDb();
		insertSession(db, mkSession({ id: "session_only", collab: cA, agent: "codex" }));
		expect(reapSupersededSessions(db, cA, "codex", "session_only")).toBe(0);
		expect(listSessionsForCollab(db, cA)).toHaveLength(1);
	});
});

describe("safeReapSessions (failure isolation, criterion 2)", () => {
	it("swallows a throwing reap and returns normally (mount/teardown unaffected)", () => {
		let logged = false;
		expect(() =>
			safeReapSessions({
				collabId: "collab_x",
				agentType: "codex",
				keepSessionId: "session_keep",
				reap: () => {
					throw new Error("boom");
				},
				logError: () => {
					logged = true;
				},
			}),
		).not.toThrow();
		expect(logged).toBe(true);
	});

	it("invokes the reap with the (collab, agent, keep) tuple when it succeeds", () => {
		const calls: Array<[string, string, string]> = [];
		safeReapSessions({
			collabId: "collab_x",
			agentType: "claude",
			keepSessionId: "session_keep",
			reap: (c, a, k) => {
				calls.push([c, a, k]);
				return 2;
			},
		});
		expect(calls).toEqual([["collab_x", "claude", "session_keep"]]);
	});
});

// Spec lines 180-183 / criterion 2: the actual mount-registration and
// stop/teardown reap PATHS (the named functions mount-session-main calls at its
// two call sites) must complete even when reapSupersededSessions throws.
// `start()` is interactive and not unit-drivable, so these dedicated path
// functions are the testable representation of those call sites.
describe("mount/teardown reap paths under a throwing reaper (criterion 2)", () => {
	const args = { collabId: "collab_x", agentType: "codex", keepSessionId: "session_keep" };
	const boom = () => {
		throw new Error("reap exploded");
	};

	it("the mount-registration path completes when the reaper throws", () => {
		let logged = false;
		expect(() =>
			reapStaleSessionsOnMount({ ...args, reap: boom, logError: () => { logged = true; } }),
		).not.toThrow();
		expect(logged).toBe(true);
	});

	it("the stop/teardown path completes when the reaper throws", () => {
		let logged = false;
		expect(() =>
			reapStaleSessionsOnTeardown({ ...args, reap: boom, logError: () => { logged = true; } }),
		).not.toThrow();
		expect(logged).toBe(true);
	});

	it("each path invokes the reaper with the (collab, agent, keep) tuple on success", () => {
		const mountCalls: Array<[string, string, string]> = [];
		const teardownCalls: Array<[string, string, string]> = [];
		reapStaleSessionsOnMount({ ...args, reap: (c, a, k) => (mountCalls.push([c, a, k]), 1) });
		reapStaleSessionsOnTeardown({ ...args, reap: (c, a, k) => (teardownCalls.push([c, a, k]), 1) });
		expect(mountCalls).toEqual([["collab_x", "codex", "session_keep"]]);
		expect(teardownCalls).toEqual([["collab_x", "codex", "session_keep"]]);
	});
});
