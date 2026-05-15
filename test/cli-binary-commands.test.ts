import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getStateFilePath } from "../packages/cli/src/runtime/paths.ts";
import { writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";

const { runCollabStartMock, runCollabStatusMock, runCollabStopMock } = vi.hoisted(
	() => ({
		runCollabStartMock: vi.fn(),
		runCollabStatusMock: vi.fn(),
		runCollabStopMock: vi.fn(),
	}),
);

vi.mock("../packages/cli/src/commands/collab/start.ts", () => ({
	runCollabStart: runCollabStartMock,
}));

vi.mock("../packages/cli/src/commands/collab/status.ts", () => ({
	runCollabStatus: runCollabStatusMock,
}));

vi.mock("../packages/cli/src/commands/collab/stop.ts", () => ({
	runCollabStop: runCollabStopMock,
}));

import { createCli } from "../packages/cli/src/create-cli.ts";

type StartArgs = {
	cwd: string;
	displayName: string;
	launchMode: "none" | "terminals" | "tmux";
	now: () => string;
};

type StopArgs = {
	workspaceRoot: string;
};

function writeStartedState(input: StartArgs) {
	writeCliCollabState(getStateFilePath(input.cwd), {
		version: 5,
		collabId: "collab_test",
		workspaceRoot: input.cwd,
		broker: {
			sqlitePath: join(
				input.cwd,
				".ai-whisper",
				"runtime",
				"broker.sqlite",
			),
			host: "127.0.0.1",
			port: 4311,
			pid: 99123,
		},
		launch: { mode: input.launchMode },
		ownedSessions: {},
		startedAt: input.now(),
		recovery: {
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		},
		adoptedSessions: {},
		mountedSessions: {},
	});
}

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
	runCollabStatusMock.mockReset();
	runCollabStopMock.mockReset();
});

describe("cli binary commands", () => {
	it("collab start creates a state file when parsed", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-bin-start-"));
		runCollabStartMock.mockImplementation((input: StartArgs) => {
			writeStartedState(input);
			return Promise.resolve(createStartResult());
		});

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

		expect(existsSync(getStateFilePath(workspaceRoot))).toBe(true);
		expect(runCollabStartMock).toHaveBeenCalledTimes(1);
	});

	it("collab status reports active after start", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-bin-status-"));

		runCollabStartMock.mockImplementation((input: StartArgs) => {
			writeStartedState(input);
			return Promise.resolve(createStartResult());
		});
		runCollabStatusMock.mockResolvedValue({
			active: true,
			collabId: "collab_test",
			roles: {
				codex: { bindingState: "unbound" },
				claude: { bindingState: "unbound" },
			},
			brokerHealth: { ok: true },
			recovery: { state: "normal" },
			activeThread: null,
		});

		const startCli = createCli();
		await startCli.parseAsync([
			"node",
			"whisper",
			"collab",
			"start",
			"--workspace",
			workspaceRoot,
			"--no-tmux",
		]);

		const statusCli = createCli();
		const originalLog = console.log;
		const captured: string[] = [];
		console.log = (...args: unknown[]) =>
			captured.push(args.map((arg) => String(arg)).join(" "));
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
		expect(runCollabStatusMock).toHaveBeenCalledTimes(1);
	});

	it("collab stop clears state file", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-bin-stop-"));

		runCollabStartMock.mockImplementation((input: StartArgs) => {
			writeStartedState(input);
			return Promise.resolve(createStartResult());
		});
		runCollabStopMock.mockImplementation((input: StopArgs) => {
			rmSync(getStateFilePath(input.workspaceRoot), { force: true });
			return { stopped: true };
		});

		const startCli = createCli();
		await startCli.parseAsync([
			"node",
			"whisper",
			"collab",
			"start",
			"--workspace",
			workspaceRoot,
			"--no-tmux",
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
		expect(runCollabStopMock).toHaveBeenCalledTimes(1);
	});
});
