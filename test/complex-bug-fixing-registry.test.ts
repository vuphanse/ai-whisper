import { describe, expect, it } from "vitest";
import {
	bugfixRunDir,
	bugfixPaths,
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
