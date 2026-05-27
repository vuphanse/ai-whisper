import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	captureWorkspaceSnapshotSync,
	diffChangedFilesSince,
} from "../packages/broker/src/runtime/workspace-snapshot.ts";

let dir: string;
const git = (...args: string[]) =>
	execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" });

describe("workspace-snapshot", () => {
	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "aiw-snap-"));
		git("init", "-q");
		git("config", "user.email", "t@t");
		git("config", "user.name", "t");
		writeFileSync(join(dir, "a.txt"), "one\n");
		// A TRACKED file under .ai-whisper/ — without the prefix filter this WOULD
		// appear in the diff, so it proves the exclusion is real (not just an
		// untracked/ignored path that git would drop anyway).
		mkdirSync(join(dir, ".ai-whisper"), { recursive: true });
		writeFileSync(join(dir, ".ai-whisper", "run.log"), "round 1\n");
		git("add", ".");
		git("commit", "-q", "-m", "init");
	});
	afterEach(() => rmSync(dir, { recursive: true, force: true }));

	it("captures a ref and diffs operator edits, EXCLUDING tracked .ai-whisper/ paths", () => {
		const ref = captureWorkspaceSnapshotSync(dir);
		expect(ref).toMatch(/^[0-9a-f]{7,40}$/);
		writeFileSync(join(dir, "a.txt"), "one\ntwo\n"); // operator edit (tracked)
		writeFileSync(join(dir, ".ai-whisper", "run.log"), "round 2\n"); // run-dir churn (tracked, must be excluded)
		const changed = diffChangedFilesSince(dir, ref!);
		expect(changed).toContain("a.txt");
		expect(changed).not.toContain(".ai-whisper/run.log"); // exact exclusion assertion (spec §4)
		expect(changed.some((f) => f.startsWith(".ai-whisper/"))).toBe(false);
	});

	it("returns null ref when the dir is not a git repo", () => {
		const nonRepo = mkdtempSync(join(tmpdir(), "aiw-nonrepo-"));
		expect(captureWorkspaceSnapshotSync(nonRepo)).toBeNull();
		rmSync(nonRepo, { recursive: true, force: true });
	});

	it("empty diff when nothing changed", () => {
		const ref = captureWorkspaceSnapshotSync(dir);
		expect(diffChangedFilesSince(dir, ref!)).toEqual([]);
	});
});
