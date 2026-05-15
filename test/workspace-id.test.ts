import { describe, expect, it } from "vitest";
import { mkdtempSync, symlinkSync, mkdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { workspaceIdFromPath } from "../packages/cli/src/runtime/workspace-id.ts";

describe("workspace-id", () => {
	it("returns 16 hex characters", () => {
		mkdirSync("/tmp/some/workspace", { recursive: true });
		const id = workspaceIdFromPath("/tmp/some/workspace");
		expect(id).toMatch(/^[0-9a-f]{16}$/);
	});

	it("is deterministic for the same canonical path", () => {
		mkdirSync("/tmp/some/workspace", { recursive: true });
		const a = workspaceIdFromPath("/tmp/some/workspace");
		const b = workspaceIdFromPath("/tmp/some/workspace");
		expect(a).toBe(b);
	});

	it("collapses symlinks via realpath", () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "wsid-"));
		const real = path.join(tmp, "real");
		const link = path.join(tmp, "link");
		mkdirSync(real);
		symlinkSync(real, link);
		expect(workspaceIdFromPath(link)).toBe(workspaceIdFromPath(real));
	});

	it("produces different ids for different canonical paths", () => {
		const tmp = mkdtempSync(path.join(os.tmpdir(), "wsid-"));
		const a = path.join(tmp, "a");
		const b = path.join(tmp, "b");
		mkdirSync(a);
		mkdirSync(b);
		expect(workspaceIdFromPath(a)).not.toBe(workspaceIdFromPath(b));
	});
});
