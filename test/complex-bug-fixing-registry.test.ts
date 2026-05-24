import { describe, expect, it } from "vitest";
import {
	bugfixRunDir,
	bugfixPaths,
	WORKFLOW_DIAGNOSIS_PROTOCOL,
} from "../packages/broker/src/runtime/workflow-registry.ts";

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
