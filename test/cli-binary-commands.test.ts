import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createCli } from "../packages/cli/src/create-cli.ts";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";

describe("cli binary commands", () => {
	it("collab start creates a state file when parsed", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-bin-start-"));
		const cli = createCli();

		await cli.parseAsync([
			"node",
			"whisper",
			"collab",
			"start",
			"--workspace",
			workspaceRoot,
		]);

		expect(existsSync(getStateFilePath(workspaceRoot))).toBe(true);
	});

	it("collab status reports active after start", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-bin-status-"));

		const startCli = createCli();
		await startCli.parseAsync([
			"node",
			"whisper",
			"collab",
			"start",
			"--workspace",
			workspaceRoot,
		]);

		const statusCli = createCli();
		const originalLog = console.log;
		const captured: string[] = [];
		console.log = (...args: unknown[]) => captured.push(args.join(" "));
		try {
			await statusCli.parseAsync([
				"node",
				"whisper",
				"collab",
				"status",
				"--workspace",
				workspaceRoot,
			]);
		} finally {
			console.log = originalLog;
		}

		expect(captured.some((line) => /active/i.test(line))).toBe(true);
	});

	it("collab stop clears state file", async () => {
		const startCli = createCli();
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-bin-stop-"));
		await startCli.parseAsync([
			"node",
			"whisper",
			"collab",
			"start",
			"--workspace",
			workspaceRoot,
		]);
		expect(existsSync(getStateFilePath(workspaceRoot))).toBe(true);

		const stopCli = createCli();
		await stopCli.parseAsync([
			"node",
			"whisper",
			"collab",
			"stop",
			"--workspace",
			workspaceRoot,
		]);

		expect(existsSync(getStateFilePath(workspaceRoot))).toBe(false);
	});
});
