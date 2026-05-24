import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowDriver } from "../packages/broker/src/runtime/workflow-driver.ts";

type Captured = {
	initialHandoffStep: string;
	kickoffText: string;
	executionBaseHeadSha?: string;
	phaseName: string;
};

/**
 * A minimal driver harness over a stubbed broker. `workspaceRoot` is a REAL temp
 * dir because the driver's bugfix/ralph setup actually `mkdirSync`es the run dir
 * on disk at kickoff — a fake "/ws" root would EACCES and halt the workflow.
 */
function makeDriverHarness(opts: { workflowType: string; specPath: string }) {
	const workspaceRoot = mkdtempSync(join(tmpdir(), "aiw-bugfix-drv-"));
	const captured: Captured[] = [];
	const events = new Map<string, Array<(e: unknown) => void>>();
	const broker = {
		control: {
			getWorkflow: () => ({
				workflowId: "wf_1",
				collabId: "c1",
				workflowType: opts.workflowType,
				currentPhaseIndex: 0,
				status: "running" as const,
				specPath: opts.specPath,
				roleBindings: { implementer: "claude", reviewer: "codex" },
				workflowContext: {},
				createdAt: "2026-05-24T00:00:00.000Z",
				haltReason: null,
			}),
			listWorkflows: () => [],
			getWorkflowPhaseRuns: () => [],
			beginPhaseRun: (input: Captured) => {
				captured.push(input);
				return { phaseRunId: "p", chainId: "ch", handoffId: "h" };
			},
			haltWorkflow: vi.fn(),
			listSessionBindings: () => [
				{ agentType: "claude", bindingState: "bound" },
				{ agentType: "codex", bindingState: "bound" },
			],
			getCollab: () => ({ workspaceRoot }),
		},
		events: {
			on: (name: string, cb: (e: unknown) => void) => {
				const arr = events.get(name) ?? [];
				arr.push(cb);
				events.set(name, arr);
				return () => {};
			},
			emit: (name: string, e: unknown) => {
				for (const cb of events.get(name) ?? []) cb(e);
			},
		},
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
	} as any;
	const headReader = { readHead: vi.fn(async () => "deadbeef") };
	const driver = createWorkflowDriver({ broker, headReader, sweepIntervalMs: 0 });
	const emit = (name: string, e: unknown): void => {
		for (const cb of events.get(name) ?? []) cb(e);
	};
	const cleanup = () => {
		driver.stop();
		rmSync(workspaceRoot, { recursive: true, force: true });
	};
	return { driver, headReader, captured, workspaceRoot, emit, cleanup };
}

describe("workflow-driver: complex-bug-fixing first-phase kickoff", () => {
	it("reads HEAD and passes it as executionBaseHeadSha for the anchored diagnosis phase", async () => {
		const h = makeDriverHarness({ workflowType: "complex-bug-fixing", specPath: "/ws/bug.md" });
		try {
			h.driver.start();
			h.emit("workflow.created", { workflowId: "wf_1" });
			await new Promise((r) => setImmediate(r));
			expect(h.headReader.readHead).toHaveBeenCalledWith(h.workspaceRoot);
			expect(h.captured[0]!.executionBaseHeadSha).toBe("deadbeef");
			expect(h.captured[0]!.phaseName).toBe("diagnosis");
		} finally {
			h.cleanup();
		}
	});

	it("renders {diagnosisPath} into the kickoff text", async () => {
		const h = makeDriverHarness({ workflowType: "complex-bug-fixing", specPath: "/ws/bug.md" });
		try {
			h.driver.start();
			h.emit("workflow.created", { workflowId: "wf_1" });
			await new Promise((r) => setImmediate(r));
			const expected = join(h.workspaceRoot, ".ai-whisper", "bugfix", "wf_1", "diagnosis.md");
			expect(h.captured[0]!.kickoffText).toContain(expected);
			expect(h.captured[0]!.kickoffText).not.toContain("{diagnosisPath}");
		} finally {
			h.cleanup();
		}
	});

	it("SDD reads HEAD only for execute phase, not on phase-0 entry (regression)", async () => {
		const h = makeDriverHarness({ workflowType: "spec-driven-development", specPath: "docs/spec.md" });
		try {
			h.driver.start();
			h.emit("workflow.created", { workflowId: "wf_1" });
			await new Promise((r) => setImmediate(r));
			// Phase 0 of SDD (spec-refining) is a review step with no base anchoring.
			expect(h.headReader.readHead).not.toHaveBeenCalled();
			expect(h.captured[0]!.executionBaseHeadSha).toBeUndefined();
		} finally {
			h.cleanup();
		}
	});

	it("ralph reads HEAD for no phase (regression)", async () => {
		const h = makeDriverHarness({ workflowType: "ralph-loop", specPath: "/ws/GOAL.md" });
		try {
			h.driver.start();
			h.emit("workflow.created", { workflowId: "wf_1" });
			await new Promise((r) => setImmediate(r));
			expect(h.headReader.readHead).not.toHaveBeenCalled();
			expect(h.captured[0]!.executionBaseHeadSha).toBeUndefined();
		} finally {
			h.cleanup();
		}
	});
});
