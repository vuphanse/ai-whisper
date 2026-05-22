import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runSkillInstall } from "../packages/cli/src/commands/skill/install.ts";

// ESM-correct repo root (matches the codebase's module type; no __dirname).
const repoRoot = fileURLToPath(new URL("..", import.meta.url));
const sourceSkillsDir = join(repoRoot, "packages/cli/skills");
const ralphSkill = join(sourceSkillsDir, "ai-whisper-ralph", "SKILL.md");

/** Run the real build copy from the real source skills dir into a temp dest. */
function copyRealSkills(): string {
	const dest = mkdtempSync(join(tmpdir(), "aiw-ralph-dist-"));
	execFileSync(
		process.execPath,
		[
			join(repoRoot, "packages/cli/scripts/copy-skills.mjs"),
			"--src",
			sourceSkillsDir,
			"--dest",
			join(dest, "skills"),
		],
		{ stdio: "pipe" },
	);
	return join(dest, "skills");
}

describe("ai-whisper-ralph skill", () => {
	it("source SKILL.md exists, names itself, and pins the ralph-loop type", () => {
		const txt = readFileSync(ralphSkill, "utf8");
		expect(txt).toMatch(/^name:\s*ai-whisper-ralph\s*$/m);
		expect(txt).toContain("--type=ralph-loop");
		expect(txt).not.toContain("--type=spec-driven-development");
	});

	it("ships into the post-build bundled dir with the ralph-loop type, alongside ai-whisper-sdd", () => {
		const bundled = copyRealSkills();
		const bundledRalph = join(bundled, "ai-whisper-ralph", "SKILL.md");
		expect(existsSync(bundledRalph)).toBe(true);
		expect(existsSync(join(bundled, "ai-whisper-sdd", "SKILL.md"))).toBe(true);
		const bundledTxt = readFileSync(bundledRalph, "utf8");
		expect(bundledTxt).toContain("--type=ralph-loop");
		expect(bundledTxt).not.toContain("--type=spec-driven-development");
	});

	it("install enumerates it into BOTH ~/.claude and ~/.codex", async () => {
		const bundled = copyRealSkills();
		const home = mkdtempSync(join(tmpdir(), "aiw-ralph-home-"));
		await runSkillInstall({
			target: "all",
			fakeHome: home,
			bundledSkillsDir: bundled,
		});
		expect(
			existsSync(join(home, ".claude", "skills", "ai-whisper-ralph", "SKILL.md")),
		).toBe(true);
		expect(
			existsSync(join(home, ".codex", "skills", "ai-whisper-ralph", "SKILL.md")),
		).toBe(true);
	});
});
