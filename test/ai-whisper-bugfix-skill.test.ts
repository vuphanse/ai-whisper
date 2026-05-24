import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { WORKFLOW_DIAGNOSIS_PROTOCOL } from "../packages/broker/src/runtime/workflow-registry.ts";

const skill = readFileSync(
	"packages/cli/skills/ai-whisper-bugfix/SKILL.md",
	"utf8",
);

describe("ai-whisper-bugfix skill", () => {
	it("starts the complex-bug-fixing workflow and is fire-and-forget", () => {
		expect(skill).toMatch(/^name:\s*ai-whisper-bugfix\s*$/m);
		expect(skill).toContain("--type=complex-bug-fixing");
		expect(skill).not.toContain("--type=ralph-loop");
		expect(skill).toContain("whisper collab status --json");
		expect(skill).toMatch(/fire-and-forget/i);
	});

	it("does NOT duplicate the canonical diagnosis review protocol (single source of truth)", () => {
		// Distinctive protocol marker lines must not be copied into the skill.
		expect(skill).not.toContain("ai-whisper diagnosis review protocol");
		expect(skill).not.toContain("Mutual-agreement gate");
		// And it shares no long verbatim slice with the protocol body.
		const marker = WORKFLOW_DIAGNOSIS_PROTOCOL.slice(60, 140);
		expect(skill).not.toContain(marker);
	});
});
