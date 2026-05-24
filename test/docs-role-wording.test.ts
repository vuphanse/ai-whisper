import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

// In-scope live surfaces only. docs/superpowers/ (historical specs/plans) is
// excluded: those are immutable design records this work supersedes, not edits.
// NOTE: a `docs/*.md` git pathspec is WRONG — git's `*` crosses `/`, so it also
// returns docs/superpowers/**. Match top-level docs with `^docs/[^/]+\.md$`.
function scanTargets(): string[] {
	const out = ["README.md"];
	const allDocs = execFileSync("git", ["-C", root, "ls-files", "docs"], { encoding: "utf8" })
		.split("\n")
		.filter(Boolean);
	out.push(...allDocs.filter((p) => /^docs\/[^/]+\.md$/.test(p))); // top-level docs only
	const skills = execFileSync("git", ["-C", root, "ls-files", "packages/cli/skills"], {
		encoding: "utf8",
	})
		.split("\n")
		.filter((p) => p.endsWith(".md"));
	out.push(...skills);
	return out.filter((p) => existsSync(resolve(root, p)));
}

// A live doc must not present a caller-independent Claude/Codex pairing, in
// either the prose form ("implementer = claude, reviewer = codex") or the
// concrete CLI-flag form ("--implementer claude --reviewer codex"). The flag
// form with literal placeholders ("--implementer <agent>") and the bare
// "--implementer / --reviewer" mention are legitimate and must NOT match.
const STALE_PATTERNS: RegExp[] = [
	/implementer\s*=\s*claude\s*,\s*reviewer\s*=\s*codex/i,
	/--implementer\s+(?:claude|codex)[\s\S]{0,40}?--reviewer\s+(?:claude|codex)/i,
];

describe("live docs do not claim a caller-independent Claude default", () => {
	it("no in-scope surface hardcodes implementer=claude / reviewer=codex (prose or CLI flags)", () => {
		const offenders: string[] = [];
		for (const rel of scanTargets()) {
			const txt = readFileSync(resolve(root, rel), "utf8");
			if (STALE_PATTERNS.some((re) => re.test(txt))) offenders.push(rel);
		}
		expect(offenders, `stale caller-independent default in: ${offenders.join(", ")}`).toEqual([]);
	});
});
