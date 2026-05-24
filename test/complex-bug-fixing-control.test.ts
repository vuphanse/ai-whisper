import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createWorkflowDriver } from "../packages/broker/src/runtime/workflow-driver.ts";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	bugfixRunDir,
	getWorkflowDefinition,
} from "../packages/broker/src/runtime/workflow-registry.ts";
import { liveReviewCommitRange } from "../packages/broker/src/control/workflow-control.ts";

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

// ---------------------------------------------------------------------------
// Broker-backed control harness (mirrors test/ralph-loop-control.test.ts), used
// to drive real verdicts through applyOrchestratorVerdict and inspect the
// rendered request_text for the new bugfix phases.
// ---------------------------------------------------------------------------

const COLLAB_ID = "collab_bugfix";
const WS_ROOT = "/tmp/bugfix-ws";

function makeBroker() {
	const dir = mkdtempSync(join(tmpdir(), "aiw-bugfix-ctl-"));
	return createBrokerRuntime({
		sqlitePath: join(dir, "x.sqlite"),
		host: "127.0.0.1",
		port: 4732,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
}

function seedCollab(broker: ReturnType<typeof makeBroker>, now = new Date().toISOString()) {
	broker.control.startCollab({
		collabId: COLLAB_ID,
		workspaceRoot: WS_ROOT,
		displayName: "bugfix",
		orchestratorEnabled: true,
		orchestratorMaxRounds: 5,
		now,
	});
	for (const agent of ["codex", "claude"] as const) {
		broker.control.setSessionBinding({
			collabId: COLLAB_ID,
			agentType: agent,
			sessionId: `session_${agent}_bugfix`,
			bindingSource: "adopted",
			now,
		});
	}
}

/** Start a complex-bug-fixing workflow and kick off the diagnosis (implement)
 *  handoff, anchoring baseBeforeExecution to `base` exactly as the driver does. */
function startBugfix(
	broker: ReturnType<typeof makeBroker>,
	base = "deadbeef",
	now = new Date().toISOString(),
) {
	const { workflowId } = broker.control.createWorkflow({
		collabId: COLLAB_ID,
		workflowType: "complex-bug-fixing",
		specPath: `${WS_ROOT}/bug.md`,
		roleBindings: { implementer: "claude", reviewer: "codex" },
		now,
	});
	const { handoffId } = broker.control.beginPhaseRun({
		workflowId,
		phaseIndex: 0,
		phaseName: "diagnosis",
		initialHandoffStep: "implement",
		kickoffText: "Diagnose the bug.",
		sender: "codex",
		target: "claude",
		maxRounds: 5,
		executionBaseHeadSha: base,
		now,
	});
	return { workflowId, handoffId };
}

function setHandback(broker: ReturnType<typeof makeBroker>, handoffId: string, text: string) {
	broker.db
		.prepare("UPDATE relay_handoff SET handback_text = ? WHERE handoff_id = ?")
		.run(text, handoffId);
}

function latestForStep(
	broker: ReturnType<typeof makeBroker>,
	workflowId: string,
	step: string,
): { handoffId: string; requestText: string } {
	const row = broker.db
		.prepare(
			"SELECT handoff_id, request_text FROM relay_handoff WHERE workflow_id = ? AND handoff_step = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
		)
		.get(workflowId, step) as { handoff_id: string; request_text: string };
	return { handoffId: row.handoff_id, requestText: row.request_text };
}

/** Deliver the current implement handoff, returning the review handoff it spawns. */
function deliverToReview(
	broker: ReturnType<typeof makeBroker>,
	workflowId: string,
	implementHandoffId: string,
	now: string,
): { handoffId: string; requestText: string } {
	setHandback(broker, implementHandoffId, "Did the work, see artifact.");
	broker.control.applyOrchestratorVerdict({
		handoffId: implementHandoffId,
		verdict: "delivered",
		confidence: 0.9,
		reason: "delivered",
		now,
	});
	return latestForStep(broker, workflowId, "review");
}

describe("workflow-control renders bugfix paths", () => {
	it("fix-and-verify review request contains {diagnosisPath} and base..HEAD {commitRange}", async () => {
		const broker = makeBroker();
		try {
			const now = "2026-05-24T00:00:00.000Z";
			seedCollab(broker, now);
			const { workflowId, handoffId } = startBugfix(broker, "deadbeef", now);

			// diagnosis: deliver implement → review → approve advances to fix-and-verify
			const diagReview = deliverToReview(broker, workflowId, handoffId, now);
			setHandback(broker, diagReview.handoffId, "Approved.");
			broker.control.applyOrchestratorVerdict({
				handoffId: diagReview.handoffId,
				verdict: "approve",
				confidence: 0.9,
				reason: "diagnosis sound",
				now,
			});

			// fix-and-verify: deliver implement → review handoff
			const fixImpl = latestForStep(broker, workflowId, "implement");
			const fixReview = deliverToReview(broker, workflowId, fixImpl.handoffId, now);

			const diagPath = `${bugfixRunDir(WS_ROOT, workflowId)}/diagnosis.md`;
			expect(fixReview.requestText).toContain(diagPath);
			expect(fixReview.requestText).toContain("deadbeef..HEAD");
			expect(fixReview.requestText).not.toMatch(/\{(diagnosisPath|commitRange|specPath)\}/);
		} finally {
			await broker.stop();
		}
	});

	it("diagnosis findings→fix request renders {diagnosisPath} and stays in the implementer layer", async () => {
		const broker = makeBroker();
		try {
			const now = "2026-05-24T00:00:00.000Z";
			seedCollab(broker, now);
			const { workflowId, handoffId } = startBugfix(broker, "deadbeef", now);

			const diagReview = deliverToReview(broker, workflowId, handoffId, now);
			setHandback(broker, diagReview.handoffId, "Findings: the repro is not real.");
			broker.control.applyOrchestratorVerdict({
				handoffId: diagReview.handoffId,
				verdict: "findings",
				confidence: 0.9,
				reason: "diagnosis defective",
				followUpMessage: "Re-run the reproduction; the cause is unproven.",
				now,
			});

			const fix = latestForStep(broker, workflowId, "fix");
			const diagPath = `${bugfixRunDir(WS_ROOT, workflowId)}/diagnosis.md`;
			expect(fix.requestText).toContain(diagPath);
			expect(fix.requestText).not.toContain("{diagnosisPath}");
			// layer separation: the reviewer protocol must not leak into the fix prompt
			expect(fix.requestText).not.toContain("ai-whisper diagnosis review protocol");
			// the reviewer findings are appended
			expect(fix.requestText).toContain("the cause is unproven");
		} finally {
			await broker.stop();
		}
	});

	it("fix-and-verify findings→fix request renders base..HEAD {commitRange}", async () => {
		const broker = makeBroker();
		try {
			const now = "2026-05-24T00:00:00.000Z";
			seedCollab(broker, now);
			const { workflowId, handoffId } = startBugfix(broker, "deadbeef", now);

			const diagReview = deliverToReview(broker, workflowId, handoffId, now);
			setHandback(broker, diagReview.handoffId, "Approved.");
			broker.control.applyOrchestratorVerdict({
				handoffId: diagReview.handoffId,
				verdict: "approve",
				confidence: 0.9,
				reason: "diagnosis sound",
				now,
			});

			const fixImpl = latestForStep(broker, workflowId, "implement");
			const fixReview = deliverToReview(broker, workflowId, fixImpl.handoffId, now);
			setHandback(broker, fixReview.handoffId, "Findings: missing edge-case test.");
			broker.control.applyOrchestratorVerdict({
				handoffId: fixReview.handoffId,
				verdict: "findings",
				confidence: 0.9,
				reason: "coverage thin",
				followUpMessage: "Add the edge-case test.",
				now,
			});

			const fix = latestForStep(broker, workflowId, "fix");
			expect(fix.requestText).toContain("deadbeef..HEAD");
			expect(fix.requestText).not.toContain("{commitRange}");
		} finally {
			await broker.stop();
		}
	});

	it("SDD findings→fix still uses the generic wrapper (regression)", async () => {
		const broker = makeBroker();
		try {
			const now = "2026-05-24T00:00:00.000Z";
			seedCollab(broker, now);
			const { workflowId } = broker.control.createWorkflow({
				collabId: COLLAB_ID,
				workflowType: "spec-driven-development",
				specPath: "docs/spec.md",
				roleBindings: { implementer: "claude", reviewer: "codex" },
				now,
			});
			// spec-refining review handoff
			const { handoffId } = broker.control.beginPhaseRun({
				workflowId,
				phaseIndex: 0,
				phaseName: "spec-refining",
				initialHandoffStep: "review",
				kickoffText: "Review the spec.",
				sender: "claude",
				target: "codex",
				maxRounds: 5,
				now,
			});
			setHandback(broker, handoffId, "Findings: tighten acceptance criteria.");
			broker.control.applyOrchestratorVerdict({
				handoffId,
				verdict: "findings",
				confidence: 0.9,
				reason: "spec vague",
				followUpMessage: "Add acceptance criteria.",
				now,
			});

			const fix = latestForStep(broker, workflowId, "fix");
			expect(fix.requestText).toMatch(/^Apply the following reviewer findings now/);
			expect(fix.requestText).not.toContain("/.ai-whisper/bugfix/");
		} finally {
			await broker.stop();
		}
	});
});

/** Drive one phase's implement → review → approve. Returns nothing; the next
 *  phase (if any) is kicked off by the engine on approve. */
function approvePhase(
	broker: ReturnType<typeof makeBroker>,
	workflowId: string,
	implementHandoffId: string,
	now: string,
) {
	const review = deliverToReview(broker, workflowId, implementHandoffId, now);
	setHandback(broker, review.handoffId, "Approved.");
	return broker.control.applyOrchestratorVerdict({
		handoffId: review.handoffId,
		verdict: "approve",
		confidence: 0.95,
		reason: "phase accepted",
		now,
	});
}

describe("complex-bug-fixing progression", () => {
	it("approve→approve→approve advances diagnosis → fix-and-verify → post-mortem → done", async () => {
		const broker = makeBroker();
		try {
			const now = "2026-05-24T00:00:00.000Z";
			seedCollab(broker, now);
			const { workflowId, handoffId } = startBugfix(broker, "deadbeef", now);

			// Phase 0 diagnosis
			approvePhase(broker, workflowId, handoffId, now);
			expect(broker.control.getWorkflow(workflowId)?.currentPhaseIndex).toBe(1);

			// Phase 1 fix-and-verify
			const fixImpl = latestForStep(broker, workflowId, "implement");
			approvePhase(broker, workflowId, fixImpl.handoffId, now);
			expect(broker.control.getWorkflow(workflowId)?.currentPhaseIndex).toBe(2);

			// Phase 2 post-mortem
			const pmImpl = latestForStep(broker, workflowId, "implement");
			const result = approvePhase(broker, workflowId, pmImpl.handoffId, now);
			expect(result.action).toBe("workflow-done");
			expect(broker.control.getWorkflow(workflowId)?.status).toBe("done");
		} finally {
			await broker.stop();
		}
	});

	it("findings on the diagnosis phase loops back to a fix step without advancing", async () => {
		const broker = makeBroker();
		try {
			const now = "2026-05-24T00:00:00.000Z";
			seedCollab(broker, now);
			const { workflowId, handoffId } = startBugfix(broker, "deadbeef", now);

			const review = deliverToReview(broker, workflowId, handoffId, now);
			setHandback(broker, review.handoffId, "Findings: cause unproven.");
			const result = broker.control.applyOrchestratorVerdict({
				handoffId: review.handoffId,
				verdict: "findings",
				confidence: 0.9,
				reason: "defective diagnosis",
				followUpMessage: "Prove the cause.",
				now,
			});

			expect(result.action).toBe("chain-continued");
			expect(broker.control.getWorkflow(workflowId)?.currentPhaseIndex).toBe(0);
			expect(broker.control.getWorkflow(workflowId)?.status).toBe("running");
			// the next handoff is a fix step in the same phase
			const latest = broker.db
				.prepare(
					"SELECT handoff_step FROM relay_handoff WHERE workflow_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
				)
				.get(workflowId) as { handoff_step: string };
			expect(latest.handoff_step).toBe("fix");
		} finally {
			await broker.stop();
		}
	});

	it("escalate on a phase halts the workflow", async () => {
		const broker = makeBroker();
		try {
			const now = "2026-05-24T00:00:00.000Z";
			seedCollab(broker, now);
			const { workflowId, handoffId } = startBugfix(broker, "deadbeef", now);

			const review = deliverToReview(broker, workflowId, handoffId, now);
			setHandback(broker, review.handoffId, "Cannot proceed; repro inputs absent.");
			const result = broker.control.applyOrchestratorVerdict({
				handoffId: review.handoffId,
				verdict: "escalate",
				confidence: 0.9,
				reason: "unreviewable",
				now,
			});

			expect(result.action).toBe("workflow-halted");
			expect(broker.control.getWorkflow(workflowId)?.status).toBe("halted");
		} finally {
			await broker.stop();
		}
	});
});

describe("commit-range anchoring (A2) and regression guard", () => {
	it("fix-and-verify review request resolves base..HEAD from the anchored base", async () => {
		const broker = makeBroker();
		try {
			const now = "2026-05-24T00:00:00.000Z";
			seedCollab(broker, now);
			// base anchored to 'cafe1234' on diagnosis entry (as the driver does).
			const { workflowId, handoffId } = startBugfix(broker, "cafe1234", now);
			approvePhase(broker, workflowId, handoffId, now);
			const fixImpl = latestForStep(broker, workflowId, "implement");
			const fixReview = deliverToReview(broker, workflowId, fixImpl.handoffId, now);
			expect(fixReview.requestText).toContain("cafe1234..HEAD");
			expect(fixReview.requestText).not.toContain("..HEAD..");
		} finally {
			await broker.stop();
		}
	});

	it("liveReviewCommitRange: anchored base → base..HEAD (SDD execute path unchanged)", () => {
		expect(liveReviewCommitRange({ baseBeforeExecution: "abc1234" })).toBe("abc1234..HEAD");
	});

	it("liveReviewCommitRange: no base → bare HEAD (ralph no-anchor path unchanged)", () => {
		expect(liveReviewCommitRange({})).toBe("HEAD");
	});
});

describe("complex-bug-fixing spec edge cases", () => {
	it("run dir is gitignored: kickoff prompts say do-not-commit and .ai-whisper/ is ignored", () => {
		// (a) Prompt-contract half: every phase kickoff instructs NOT to commit the run dir.
		const def = getWorkflowDefinition("complex-bug-fixing")!;
		for (const phase of def.phases) {
			const kickoff = phase.stepTemplates.implement ?? phase.kickoffTemplate;
			expect(kickoff).toMatch(/do not commit[\s\S]*\{bugfixDir\}|gitignored/i);
		}
		// (b) Ignore half: a real git repo whose .gitignore has ".ai-whisper/" ignores the run dir.
		const repo = mkdtempSync(join(tmpdir(), "aiw-bugfix-git-"));
		try {
			execFileSync("git", ["init", "-q"], { cwd: repo });
			writeFileSync(join(repo, ".gitignore"), ".ai-whisper/\n");
			const target = join(bugfixRunDir(repo, "wf_x"), "diagnosis.md");
			// exit code 0 = path is ignored; throws (non-zero) otherwise.
			expect(() =>
				execFileSync("git", ["check-ignore", "-q", target], { cwd: repo }),
			).not.toThrow();
		} finally {
			rmSync(repo, { recursive: true, force: true });
		}
	});

	it("non-delivery on a bugfix implement step still escalates (engine guard intact)", async () => {
		const broker = makeBroker();
		try {
			const now = "2026-05-24T00:00:00.000Z";
			seedCollab(broker, now);
			const { workflowId, handoffId } = startBugfix(broker, "deadbeef", now);
			// A one-word/non-delivering handback resolves to an escalate verdict at the
			// implement step; the new definition must not bypass the generic halt.
			setHandback(broker, handoffId, "ok");
			const result = broker.control.applyOrchestratorVerdict({
				handoffId,
				verdict: "escalate",
				confidence: 0.9,
				reason: "non-delivery",
				now,
			});
			expect(result.action).toBe("workflow-halted");
			expect(broker.control.getWorkflow(workflowId)?.status).toBe("halted");
		} finally {
			await broker.stop();
		}
	});
});
