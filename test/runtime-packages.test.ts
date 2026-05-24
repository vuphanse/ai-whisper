import { describe, expect, it } from "vitest";
import { adapterClaudePackage } from "../packages/adapter-claude/src/index.ts";
import { adapterCodexPackage } from "../packages/adapter-codex/src/index.ts";
import { brokerPackage } from "../packages/broker/src/index.ts";
import { cliPackage, createCli } from "../packages/cli/src/index.ts";
import { companionCorePackage } from "../packages/companion-core/src/index.ts";

describe("runtime package boundaries", () => {
	it("exposes minimal package entry points for every runtime package", () => {
		expect(cliPackage.name).toBe("ai-whisper");
		expect(brokerPackage.name).toBe("@ai-whisper/broker");
		expect(companionCorePackage.name).toBe("@ai-whisper/companion-core");
		expect(adapterCodexPackage.name).toBe("@ai-whisper/adapter-codex");
		expect(adapterClaudePackage.name).toBe("@ai-whisper/adapter-claude");
	});

	it("exports the Phase 5 CLI factory", () => {
		expect(typeof createCli).toBe("function");
	});
});
