import { describe, expect, it } from "vitest";
import { partitionWallGroups } from "../packages/cli/src/runtime/dashboard-state.ts";
import type { CollabSummary } from "@ai-whisper/broker";

function s(p: Partial<CollabSummary>): CollabSummary {
	return {
		collabId: p.collabId ?? "c",
		label: "x",
		workflowId: p.workflowId ?? "wf",
		workflowType: "spec-driven-development",
		workflowStatus: p.workflowStatus ?? "running",
		currentPhaseRunId: null,
		phaseIndex: 0,
		phaseName: "p",
		currentRound: 1,
		maxRounds: 3,
		chainStatus: p.chainStatus ?? "active",
		turn: { owner: "codex", waiting: "claude", handoffState: "accepted" },
		sessions: [
			{ agentType: "codex", healthState: "healthy", mountAlive: true },
			{ agentType: "claude", healthState: "healthy", mountAlive: true },
		],
		workflowCreatedAt: p.workflowCreatedAt ?? "2026-05-20T00:00:00.000Z",
		lastActivityAt: p.lastActivityAt ?? "2026-05-20T00:00:00.000Z",
		...p,
	};
}

describe("partitionWallGroups", () => {
	it("partitions into ACTIVE / IDLE-MANUAL / HALTED / DONE-CANCELED in that order", () => {
		const out = partitionWallGroups([
			s({ collabId: "d", workflowStatus: "done" }),
			s({ collabId: "h", workflowStatus: "halted" }),
			s({ collabId: "m", workflowId: null, workflowStatus: null, workflowType: null }),
			s({ collabId: "r", workflowStatus: "running" }),
			s({ collabId: "x", workflowStatus: "canceled" }),
		]);
		expect(out.active.map((x) => x.collabId)).toEqual(["r"]);
		expect(out.idleManual.map((x) => x.collabId)).toEqual(["m"]);
		expect(out.halted.map((x) => x.collabId)).toEqual(["h"]);
		expect(out.doneCanceled.map((x) => x.collabId)).toEqual(["d", "x"]);
	});

	it("sorts each group by workflowCreatedAt descending", () => {
		const out = partitionWallGroups([
			s({ collabId: "old", workflowStatus: "running", workflowCreatedAt: "2026-01-01T00:00:00Z" }),
			s({ collabId: "new", workflowStatus: "running", workflowCreatedAt: "2026-05-01T00:00:00Z" }),
			s({ collabId: "mid", workflowStatus: "running", workflowCreatedAt: "2026-03-01T00:00:00Z" }),
		]);
		expect(out.active.map((x) => x.collabId)).toEqual(["new", "mid", "old"]);
	});

	it("idle/manual sort falls back to lastActivityAt desc", () => {
		const out = partitionWallGroups([
			s({
				collabId: "a",
				workflowId: null,
				workflowStatus: null,
				workflowType: null,
				workflowCreatedAt: null,
				lastActivityAt: "2026-05-20T00:00:00Z",
			}),
			s({
				collabId: "b",
				workflowId: null,
				workflowStatus: null,
				workflowType: null,
				workflowCreatedAt: null,
				lastActivityAt: "2026-05-25T00:00:00Z",
			}),
		]);
		expect(out.idleManual.map((x) => x.collabId)).toEqual(["b", "a"]);
	});

	it("pins stuck-running rows to the front of ACTIVE, then recency among each subgroup", () => {
		const out = partitionWallGroups([
			s({
				collabId: "ok-old",
				workflowStatus: "running",
				workflowCreatedAt: "2026-01-01T00:00:00Z",
				chainStatus: "active",
			}),
			s({
				collabId: "stuck-new",
				workflowStatus: "running",
				workflowCreatedAt: "2026-05-01T00:00:00Z",
				chainStatus: "escalated",
			}),
			s({
				collabId: "stuck-old",
				workflowStatus: "running",
				workflowCreatedAt: "2026-02-01T00:00:00Z",
				chainStatus: "escalated",
			}),
			s({
				collabId: "ok-new",
				workflowStatus: "running",
				workflowCreatedAt: "2026-04-01T00:00:00Z",
				chainStatus: "active",
			}),
		]);
		expect(out.active.map((x) => x.collabId)).toEqual([
			"stuck-new",
			"stuck-old", // stuck block first, recent first
			"ok-new",
			"ok-old", // non-stuck block, recent first
		]);
	});

	it("never emits a paused group (paused deferred)", () => {
		const out = partitionWallGroups([
			// Defensive: even if upstream surfaces a paused row, it must not appear on the Wall.
			s({ collabId: "p", workflowStatus: "running" }), // proxy for sanity
		]);
		expect((out as Record<string, unknown>).paused).toBeUndefined();
	});
});
