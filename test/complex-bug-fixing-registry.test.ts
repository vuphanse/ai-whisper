import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join as pjoin } from "node:path";
import { describe, expect, it } from "vitest";
import {
	bugfixRunDir,
	bugfixPaths,
	WORKFLOW_DIAGNOSIS_PROTOCOL,
	getWorkflowDefinition,
	listWorkflowTypes,
	renderTemplate,
} from "../packages/broker/src/runtime/workflow-registry.ts";
import { ensureBugfixWorkspace } from "../packages/broker/src/runtime/bugfix-setup.ts";

describe("bugfixRunDir / bugfixPaths", () => {
	it("bugfixRunDir joins workspace + .ai-whisper/bugfix/<workflowId>", () => {
		expect(bugfixRunDir("/ws", "wf_123")).toBe("/ws/.ai-whisper/bugfix/wf_123");
	});

	it("bugfixPaths nests diagnosis.md and postmortem.md under the run dir", () => {
		const p = bugfixPaths("/ws", "wf_123");
		expect(p.bugfixDir).toBe("/ws/.ai-whisper/bugfix/wf_123");
		expect(p.diagnosisPath).toBe("/ws/.ai-whisper/bugfix/wf_123/diagnosis.md");
		expect(p.postmortemPath).toBe("/ws/.ai-whisper/bugfix/wf_123/postmortem.md");
	});
});

describe("WORKFLOW_DIAGNOSIS_PROTOCOL content contract", () => {
	const p = WORKFLOW_DIAGNOSIS_PROTOCOL;
	it("carries each required reviewer obligation as a stable marker", () => {
		expect(p).toMatch(/independently reproduce/i);
		expect(p).toMatch(/causal claim/i);
		expect(p).toMatch(/whack-a-mole/i);
		expect(p).toMatch(/blast radius/i);
		expect(p).toMatch(/residual risk/i);
		expect(p).toMatch(/mutual.agreement/i);
		expect(p).toContain("Non-blocking risks:");
	});
	it("is autonomous-no-human and substantial", () => {
		expect(p).toMatch(/no human/i);
		expect(p.length).toBeGreaterThan(400);
	});
});

describe("complex-bug-fixing workflow definition", () => {
	const def = getWorkflowDefinition("complex-bug-fixing");

	it("is registered and listed", () => {
		expect(def).toBeDefined();
		expect(listWorkflowTypes()).toContain("complex-bug-fixing");
		expect(def!.defaultImplementer).toBe("claude");
		expect(def!.defaultReviewer).toBe("codex");
	});

	it("has exactly three phases in order with the specified gates/roles/keys/rounds", () => {
		const names = def!.phases.map((p) => p.name);
		expect(names).toEqual(["diagnosis", "fix-and-verify", "post-mortem"]);
		const [diag, fix, pm] = def!.phases;
		expect(diag!.initialHandoffStep).toBe("implement");
		expect(diag!.reviewerRole).toBe("reviewer");
		expect(diag!.reviewMode).toBe("phase-review");
		expect(diag!.evaluatorPromptKey).toBe("review-loop");
		expect(diag!.maxRounds).toBe(5);
		expect(diag!.anchorCommitBaseOnEntry).toBe(true);
		expect(fix!.reviewMode).toBe("acceptance-review");
		expect(fix!.evaluatorPromptKey).toBe("review-loop");
		expect(fix!.maxRounds).toBe(5);
		expect(fix!.anchorCommitBaseOnEntry).toBeFalsy();
		expect(pm!.reviewMode).toBe("phase-review");
		expect(pm!.maxRounds).toBe(3);
		// All three phases opt into fix-template rendering on findings loops.
		expect(diag!.renderFixTemplateOnFindings).toBe(true);
		expect(fix!.renderFixTemplateOnFindings).toBe(true);
		expect(pm!.renderFixTemplateOnFindings).toBe(true);
	});

	it("diagnosis REVIEW template embeds the diagnosis protocol, not the generic one", () => {
		const diag = def!.phases[0]!;
		expect(diag.stepTemplates.review).toContain("ai-whisper diagnosis review protocol");
		expect(diag.stepTemplates.review).not.toContain("ai-whisper workflow review protocol");
	});

	it("diagnosis FIX template (implementer-facing) does NOT embed the diagnosis protocol", () => {
		const diag = def!.phases[0]!;
		expect(diag.stepTemplates.fix ?? "").not.toContain("ai-whisper diagnosis review protocol");
	});

	it("fix-and-verify acceptance template embeds the generic review protocol", () => {
		const fix = def!.phases[1]!;
		expect(fix.stepTemplates.review).toContain("ai-whisper workflow review protocol");
		expect(fix.stepTemplates.review).toMatch(/coverage/i);
	});

	it("phase templates render all placeholders with no stray braces", () => {
		for (const phase of def!.phases) {
			for (const tmpl of [phase.kickoffTemplate, ...Object.values(phase.stepTemplates)]) {
				const out = renderTemplate(tmpl, {
					specPath: "/ws/bug.md",
					bugfixDir: "/ws/.ai-whisper/bugfix/wf_1",
					diagnosisPath: "/ws/.ai-whisper/bugfix/wf_1/diagnosis.md",
					postmortemPath: "/ws/.ai-whisper/bugfix/wf_1/postmortem.md",
					commitRange: "abc..HEAD",
					reviewMode: phase.reviewMode ?? "phase-review",
				});
				expect(out).not.toMatch(/\{(specPath|bugfixDir|diagnosisPath|postmortemPath|commitRange|reviewMode)\}/);
			}
		}
	});
});

describe("ensureBugfixWorkspace", () => {
	it("creates the run dir idempotently and returns its path", () => {
		const ws = mkdtempSync(pjoin(tmpdir(), "bugfix-ws-"));
		try {
			const dir = ensureBugfixWorkspace(ws, "wf_x");
			expect(dir).toBe(pjoin(ws, ".ai-whisper", "bugfix", "wf_x"));
			expect(existsSync(dir)).toBe(true);
			expect(() => ensureBugfixWorkspace(ws, "wf_x")).not.toThrow(); // idempotent
		} finally {
			rmSync(ws, { recursive: true, force: true });
		}
	});
});
