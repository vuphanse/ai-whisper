import { describe, expect, it } from "vitest";
import { buildClaudeInteractiveBrokerPrompt } from "../packages/adapter-claude/src/claude-live-session-prompt.ts";
import { buildCodexInteractiveBrokerPrompt } from "../packages/adapter-codex/src/codex-live-session-prompt.ts";

describe("interactive prompt builders", () => {
	it("keeps the Claude interactive broker prompt minimal and framed", () => {
		const prompt = buildClaudeInteractiveBrokerPrompt({
			workItemId: "work_probe",
			collabId: "collab_probe",
			threadId: "thread_probe",
			requestedAction: "answer_question",
			instruction: "Explain the main risk in one sentence.",
		});

		expect(prompt).toContain("AI_WHISPER_REPLY_BEGIN:work_probe");
		expect(prompt).toContain("AI_WHISPER_REPLY_END:work_probe");
		expect(prompt).toContain('{"kind":"answer","content":"...');
		expect(prompt).toContain("instruction=Explain the main risk in one sentence.");
		expect(prompt).toContain("Reply with exactly three lines and nothing else.");
		expect(prompt).not.toContain("\n");
		expect(prompt).not.toContain("Return ONLY valid JSON.");
		expect(prompt).not.toContain('"kind": "answer" | "review" | "clarification" | "failure"');
	});

	it("keeps the Codex interactive broker prompt minimal and framed", () => {
		const prompt = buildCodexInteractiveBrokerPrompt({
			workItemId: "work_probe",
			collabId: "collab_probe",
			threadId: "thread_probe",
			requestedAction: "answer_question",
			instruction: "Explain the main risk in one sentence.",
		});

		expect(prompt).toContain("AI_WHISPER_REPLY_BEGIN:work_probe");
		expect(prompt).toContain("AI_WHISPER_REPLY_END:work_probe");
		expect(prompt).toContain('{"kind":"answer","content":"...');
		expect(prompt).toContain("instruction=Explain the main risk in one sentence.");
		expect(prompt).toContain("Reply with exactly three lines and nothing else.");
		expect(prompt).not.toContain("\n");
		expect(prompt).not.toContain("Return ONLY valid JSON.");
		expect(prompt).not.toContain('"kind": "answer" | "review" | "clarification" | "failure"');
		expect(prompt).not.toContain("collabId:");
		expect(prompt).not.toContain("threadId:");
		expect(prompt).not.toContain("workItemId:");
	});
});
