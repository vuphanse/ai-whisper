import { mkdtempSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureNodePtySpawnHelperExecutable } from "../packages/shared/src/index.ts";

describe("node-pty support", () => {
	const tempDirs: string[] = [];

	afterEach(() => {
		for (const dir of tempDirs) {
			rmSync(join(dir, "lib", "unixTerminal.js"), { force: true });
			rmSync(
				join(dir, "prebuilds", `${process.platform}-${process.arch}`, "spawn-helper"),
				{ force: true },
			);
		}
	});

	it("adds execute permission to the discovered spawn-helper", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "node-pty-support-"));
		tempDirs.push(packageDir);
		mkdirSync(join(packageDir, "lib"), { recursive: true });
		mkdirSync(join(packageDir, "prebuilds", `${process.platform}-${process.arch}`), {
			recursive: true,
		});
		writeFileSync(join(packageDir, "lib", "unixTerminal.js"), "");
		const helperPath = join(
			packageDir,
			"prebuilds",
			`${process.platform}-${process.arch}`,
			"spawn-helper",
		);
		writeFileSync(helperPath, "#!/bin/sh\n");

		expect(statSync(helperPath).mode & 0o111).toBe(0);

		expect(
			ensureNodePtySpawnHelperExecutable({
				unixTerminalPath: join(packageDir, "lib", "unixTerminal.js"),
			}),
		).toBe(helperPath);

		expect(statSync(helperPath).mode & 0o111).toBe(0o111);
	});

	it("returns null when no spawn-helper is present", () => {
		const packageDir = mkdtempSync(join(tmpdir(), "node-pty-support-"));
		tempDirs.push(packageDir);
		mkdirSync(join(packageDir, "lib"), { recursive: true });
		writeFileSync(join(packageDir, "lib", "unixTerminal.js"), "");

		expect(
			ensureNodePtySpawnHelperExecutable({
				unixTerminalPath: join(packageDir, "lib", "unixTerminal.js"),
			}),
		).toBeNull();
	});
});
