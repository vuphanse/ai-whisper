import { describe, expect, it } from "vitest";
import { buildClaudeInteractiveBrokerPrompt } from "../packages/adapter-claude/src/claude-live-session-prompt.ts";
import { buildCodexInteractiveBrokerPrompt } from "../packages/adapter-codex/src/codex-live-session-prompt.ts";

describe("interactive prompt builders", () => {
	it("keeps the Claude interactive broker prompt minimal and framed", () => {
		const requestFilePath = "/tmp/artifacts/work_probe/request.json";
		const workItemId = "work_probe";
		const prompt = buildClaudeInteractiveBrokerPrompt(requestFilePath, workItemId);

		expect(prompt).toContain(requestFilePath);
		expect(prompt).toContain("AI_WHISPER_REPLY_BEGIN:work_probe");
		expect(prompt).toContain("AI_WHISPER_REPLY_END:work_probe");
		expect(prompt).toContain('{"kind":"answer","content":"...');
		expect(prompt).toContain("Reply with exactly three lines and nothing else.");
		expect(prompt).not.toContain("instruction=");
		expect(prompt).not.toContain("action=");
		expect(prompt).not.toContain("Return ONLY valid JSON.");
		expect(prompt).not.toContain('"kind": "answer" | "review" | "clarification" | "failure"');
		expect(prompt).not.toContain("\n");
	});

	it("keeps the Codex interactive broker prompt minimal and framed", () => {
		const requestFilePath = "/tmp/artifacts/work_probe/request.json";
		const workItemId = "work_probe";
		const prompt = buildCodexInteractiveBrokerPrompt(requestFilePath, workItemId);

		expect(prompt).toContain(requestFilePath);
		expect(prompt).toContain("AI_WHISPER_REPLY_BEGIN:work_probe");
		expect(prompt).toContain("AI_WHISPER_REPLY_END:work_probe");
		expect(prompt).toContain('{"kind":"answer","content":"...');
		expect(prompt).toContain("Reply with exactly three lines and nothing else.");
		expect(prompt).not.toContain("instruction=");
		expect(prompt).not.toContain("action=");
		expect(prompt).not.toContain("Return ONLY valid JSON.");
		expect(prompt).not.toContain('"kind": "answer" | "review" | "clarification" | "failure"');
		expect(prompt).not.toContain("collabId:");
		expect(prompt).not.toContain("threadId:");
		expect(prompt).not.toContain("workItemId:");
		expect(prompt).not.toContain("\n");
	});
});
