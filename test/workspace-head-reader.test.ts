import { describe, expect, it } from "vitest";
import { execSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceHeadReader } from "../packages/broker/src/runtime/workspace-head-reader.ts";

function initRepo(): string {
	const dir = mkdtempSync(join(tmpdir(), "whisper-head-"));
	execSync("git init --quiet", { cwd: dir });
	execSync("git -c user.email=t@t -c user.name=t commit --allow-empty -m init --quiet", { cwd: dir });
	return dir;
}

describe("workspace-head-reader", () => {
	it("returns current HEAD sha", async () => {
		const dir = initRepo();
		const reader = createWorkspaceHeadReader();
		const sha = await reader.readHead(dir);
		expect(sha).toMatch(/^[0-9a-f]{7,40}$/);
	});

	it("throws a descriptive error for non-git dirs", async () => {
		const reader = createWorkspaceHeadReader();
		await expect(reader.readHead("/tmp")).rejects.toThrow();
	});
});
