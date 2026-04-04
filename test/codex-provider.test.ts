import { EventEmitter } from "node:events";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BrokerArtifactHandle, ProviderWorkRequest } from "../packages/shared/src/index.ts";

const spawnMock = vi.fn();

vi.mock("node:child_process", () => ({
	spawn: (...args: unknown[]) => spawnMock(...args),
}));

const REQUEST: ProviderWorkRequest = {
	workItemId: "work_codex_provider_test",
	collabId: "collab_test",
	threadId: "thread_test",
	requestedAction: "answer_question",
	instruction: "Reply with minimal JSON.",
};

const HANDLE: BrokerArtifactHandle = {
	workItemId: "work_codex_provider_test",
	artifactDirPath: "/tmp/artifacts/work_codex_provider_test",
	requestFilePath: "/tmp/artifacts/work_codex_provider_test/request.json",
	statusFilePath: "/tmp/artifacts/work_codex_provider_test/status.json",
};

describe("createCodexProvider", () => {
	beforeEach(() => {
		spawnMock.mockReset();
	});

	it("parses a successful provider reply from stderr when stdout is empty", async () => {
		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
		};
		child.stdout = stdout;
		child.stderr = stderr;
		spawnMock.mockReturnValue(child);

		const { createCodexProvider } = await import("../packages/adapter-codex/src/create-codex-provider.ts");
		const provider = createCodexProvider({
			executable: "codex",
			execArgs: ["exec"],
		});

		const replyPromise = provider.handleWork(REQUEST, { artifactHandle: HANDLE });

		stderr.write("OpenAI Codex v0.118.0\n");
		stderr.write('{"kind":"answer","content":"ok","transitionIntent":"completed"}\n');
		child.emit("close", 0);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "ok",
			transitionIntent: "completed",
		});
	});

	it("uses --output-last-message for file-backed broker execution and parses the written message", async () => {
		const artifactDirPath = mkdtempSync(join(tmpdir(), "ai-whisper-codex-provider-"));
		const handle: BrokerArtifactHandle = {
			workItemId: "work_codex_provider_file",
			artifactDirPath,
			requestFilePath: join(artifactDirPath, "request.json"),
			statusFilePath: join(artifactDirPath, "status.json"),
		};

		const stdout = new PassThrough();
		const stderr = new PassThrough();
		const child = new EventEmitter() as EventEmitter & {
			stdout: PassThrough;
			stderr: PassThrough;
		};
		child.stdout = stdout;
		child.stderr = stderr;
		spawnMock.mockReturnValue(child);

		const { createCodexProvider } = await import("../packages/adapter-codex/src/create-codex-provider.ts");
		const provider = createCodexProvider({
			executable: "codex",
			execArgs: ["exec", "--add-dir", artifactDirPath],
		});

		const replyPromise = provider.handleWork(REQUEST, { artifactHandle: handle });

		const spawnArgs = spawnMock.mock.calls[0]?.[1];
		expect(spawnArgs).toContain("--output-last-message");
		const outputFilePath = spawnArgs?.[spawnArgs.indexOf("--output-last-message") + 1];
		expect(typeof outputFilePath).toBe("string");
		writeFileSync(
			String(outputFilePath),
			'{"kind":"answer","content":"from-file","transitionIntent":"completed"}\n',
		);

		child.emit("close", 0);

		await expect(replyPromise).resolves.toEqual({
			kind: "answer",
			content: "from-file",
			transitionIntent: "completed",
		});
	});
});
