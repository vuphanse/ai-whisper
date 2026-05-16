import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const {
	runCollabStartMock,
	recordLaunchedSessionsMock,
	runCollabStatusMock,
	runCollabStopMock,
} = vi.hoisted(() => ({
	runCollabStartMock: vi.fn(),
	recordLaunchedSessionsMock: vi.fn(),
	runCollabStatusMock: vi.fn(),
	runCollabStopMock: vi.fn(),
}));

vi.mock("../packages/cli/src/commands/collab/start.ts", () => ({
	runCollabStart: runCollabStartMock,
	recordLaunchedSessions: recordLaunchedSessionsMock,
}));

vi.mock("../packages/cli/src/commands/collab/status.ts", () => ({
	runCollabStatus: runCollabStatusMock,
}));

vi.mock("../packages/cli/src/commands/collab/stop.ts", () => ({
	runCollabStop: runCollabStopMock,
}));

import { createCli } from "../packages/cli/src/create-cli.ts";

function createStartResult() {
	return {
		collabId: "collab_test",
		host: "127.0.0.1" as const,
		port: 4311,
		pid: 99123,
	};
}

afterEach(() => {
	runCollabStartMock.mockReset();
	recordLaunchedSessionsMock.mockReset();
	runCollabStatusMock.mockReset();
	runCollabStopMock.mockReset();
});

describe("cli binary commands", () => {
	it("collab start invokes runCollabStart with parsed arguments", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-bin-start-"));
		runCollabStartMock.mockResolvedValue(createStartResult());

		const cli = createCli();
		await cli.parseAsync([
			"node",
			"whisper",
			"collab",
			"start",
			"--workspace",
			workspaceRoot,
			"--no-tmux",
		]);

		expect(runCollabStartMock).toHaveBeenCalledTimes(1);
		expect(runCollabStartMock).toHaveBeenCalledWith(
			expect.objectContaining({
				cwd: workspaceRoot,
				displayName: "phase5",
			}),
		);
	});

	it("collab status invokes runCollabStatus and writes its output to stdout", async () => {
		runCollabStatusMock.mockReturnValue(
			[
				"collabId: collab_test",
				"workspace: /tmp/ws",
				"status: active",
				"launch: none",
				"daemon: not running",
				"recovery: normal",
			].join("\n"),
		);

		const cli = createCli();
		const originalLog = console.log;
		const captured: string[] = [];
		console.log = (...args: unknown[]) =>
			captured.push(args.map((arg) => String(arg)).join(" "));
		try {
			await cli.parseAsync(["node", "whisper", "collab", "status"]);
		} finally {
			console.log = originalLog;
		}

		expect(captured.some((line) => /active/i.test(line))).toBe(true);
		expect(runCollabStatusMock).toHaveBeenCalledTimes(1);
	});

	it("collab stop invokes runCollabStop", async () => {
		runCollabStopMock.mockResolvedValue(undefined);

		const cli = createCli();
		await cli.parseAsync(["node", "whisper", "collab", "stop"]);

		expect(runCollabStopMock).toHaveBeenCalledTimes(1);
	});
});
