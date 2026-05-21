import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRalphWorkspace } from "../packages/broker/src/runtime/ralph-setup.ts";

describe("ensureRalphWorkspace", () => {
	let ws: string;
	beforeEach(() => { ws = mkdtempSync(join(tmpdir(), "ralph-setup-")); });
	afterEach(() => { rmSync(ws, { recursive: true, force: true }); });

	it("creates the run dir and a self-gitignore of '*'", () => {
		const dir = ensureRalphWorkspace(ws, "wf_1");
		expect(dir).toBe(join(ws, ".ai-whisper", "ralph", "wf_1"));
		expect(existsSync(dir)).toBe(true);
		expect(readFileSync(join(ws, ".ai-whisper", ".gitignore"), "utf8").trim()).toBe("*");
	});

	it("is idempotent and does not edit the user's root .gitignore", () => {
		writeFileSync(join(ws, ".gitignore"), "node_modules\n");
		ensureRalphWorkspace(ws, "wf_1");
		ensureRalphWorkspace(ws, "wf_1");
		expect(readFileSync(join(ws, ".gitignore"), "utf8")).toBe("node_modules\n");
	});

	it("does not overwrite an existing .ai-whisper/.gitignore", () => {
		mkdirSync(join(ws, ".ai-whisper"), { recursive: true });
		writeFileSync(join(ws, ".ai-whisper", ".gitignore"), "custom\n");
		ensureRalphWorkspace(ws, "wf_1");
		expect(readFileSync(join(ws, ".ai-whisper", ".gitignore"), "utf8")).toBe("custom\n");
	});

	it("guarantees ralph run-state is ignored even when .ai-whisper/.gitignore has incompatible content", () => {
		// A pre-existing .ai-whisper/.gitignore that does NOT ignore ralph/ must
		// not leave run-state trackable: a self-owned ralph/.gitignore ('*')
		// ignores everything under the ralph/ dir regardless of the parent.
		mkdirSync(join(ws, ".ai-whisper"), { recursive: true });
		writeFileSync(join(ws, ".ai-whisper", ".gitignore"), "keep-me.txt\n");
		ensureRalphWorkspace(ws, "wf_1");
		expect(readFileSync(join(ws, ".ai-whisper", ".gitignore"), "utf8")).toBe("keep-me.txt\n"); // user file untouched
		expect(readFileSync(join(ws, ".ai-whisper", "ralph", ".gitignore"), "utf8").trim()).toBe("*");
	});
});
