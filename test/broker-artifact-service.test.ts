import fs from "node:fs";
import os from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BrokerArtifactService } from "../packages/cli/src/runtime/broker-artifact-service.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempRoot(): string {
	return fs.mkdtempSync(join(os.tmpdir(), "broker-artifact-test-"));
}

function makeService(tempRoot: string): BrokerArtifactService {
	return new BrokerArtifactService(tempRoot);
}

const BASE_INPUT = {
	workItemId: "work_smoke_codex",
	collabId: "collab_001",
	threadId: "thread_001",
	requestedAction: "solve",
	instruction: "do the thing",
	provider: "codex",
	sessionId: "session_abc",
	now: "2026-04-04T15:30:00.000Z",
};

function readJson(filePath: string): unknown {
	return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BrokerArtifactService", () => {
	let tempRoot: string;
	let service: BrokerArtifactService;

	beforeEach(() => {
		tempRoot = makeTempRoot();
		service = makeService(tempRoot);
	});

	afterEach(() => {
		fs.rmSync(tempRoot, { recursive: true, force: true });
	});

	it("creates user-scoped artifact directory under temp root with correct naming format", () => {
		const handle = service.createArtifact(BASE_INPUT);

		// Directory should exist
		expect(fs.existsSync(handle.artifactDirPath)).toBe(true);

		// Name format: YYYY-MM-DDTHH-mm-ssZ-{workItemId} — colons and dots replaced
		const dirName = handle.artifactDirPath.split("/").pop()!;
		expect(dirName).toBe("2026-04-04T15-30-00-000Z-work_smoke_codex");

		// Handle paths should be inside the artifact dir
		expect(handle.requestFilePath).toBe(join(handle.artifactDirPath, "request.json"));
		expect(handle.statusFilePath).toBe(join(handle.artifactDirPath, "status.json"));
		expect(handle.workItemId).toBe("work_smoke_codex");
	});

	it("writes request.json with all required fields and schemaVersion: 1", () => {
		const handle = service.createArtifact(BASE_INPUT);
		const req = readJson(handle.requestFilePath) as Record<string, unknown>;

		expect(req["schemaVersion"]).toBe(1);
		expect(req["workItemId"]).toBe("work_smoke_codex");
		expect(req["collabId"]).toBe("collab_001");
		expect(req["threadId"]).toBe("thread_001");
		expect(req["requestedAction"]).toBe("solve");
		expect(req["instruction"]).toBe("do the thing");
	});

	it("writes status.json with all required fields, currentState: pending, and initial transition", () => {
		const handle = service.createArtifact(BASE_INPUT);
		const status = readJson(handle.statusFilePath) as Record<string, unknown>;

		expect(status["schemaVersion"]).toBe(1);
		expect(status["workItemId"]).toBe("work_smoke_codex");
		expect(status["provider"]).toBe("codex");
		expect(status["sessionId"]).toBe("session_abc");
		expect(status["requestFilePath"]).toBe(handle.requestFilePath);
		expect(status["currentState"]).toBe("pending");
		expect(status["createdAt"]).toBe("2026-04-04T15:30:00.000Z");
		expect(status["updatedAt"]).toBe("2026-04-04T15:30:00.000Z");

		const transitions = status["transitions"] as Array<Record<string, unknown>>;
		expect(transitions).toHaveLength(1);
		expect(transitions[0]!["state"]).toBe("pending");
		expect(transitions[0]!["reason"]).toBe("artifact_created");
		expect(transitions[0]!["at"]).toBe("2026-04-04T15:30:00.000Z");

		const attempts = status["attempts"] as unknown[];
		expect(attempts).toHaveLength(0);
	});

	it("records attempt start — appends to attempts array, does not rewrite request.json", () => {
		const handle = service.createArtifact(BASE_INPUT);
		const reqStatBefore = fs.statSync(handle.requestFilePath);

		service.recordAttemptStart({
			artifactHandle: handle,
			attemptNumber: 1,
			submitStrategy: "direct-paste",
			startedAt: "2026-04-04T15:30:05.000Z",
		});

		// request.json must not change
		const reqStatAfter = fs.statSync(handle.requestFilePath);
		expect(reqStatAfter.mtimeMs).toBe(reqStatBefore.mtimeMs);

		const status = readJson(handle.statusFilePath) as Record<string, unknown>;
		const attempts = status["attempts"] as Array<Record<string, unknown>>;
		expect(attempts).toHaveLength(1);
		expect(attempts[0]!["attemptNumber"]).toBe(1);
		expect(attempts[0]!["submitStrategy"]).toBe("direct-paste");
		expect(attempts[0]!["startedAt"]).toBe("2026-04-04T15:30:05.000Z");
		expect(attempts[0]!["result"]).toBeUndefined();
	});

	it("records attempt result — updates attempt entry with result and endedAt", () => {
		const handle = service.createArtifact(BASE_INPUT);
		service.recordAttemptStart({
			artifactHandle: handle,
			attemptNumber: 1,
			submitStrategy: "direct-paste",
			startedAt: "2026-04-04T15:30:05.000Z",
		});
		service.recordAttemptResult({
			artifactHandle: handle,
			attemptNumber: 1,
			result: "replied",
			endedAt: "2026-04-04T15:30:10.000Z",
			outputTail: "some output",
		});

		const status = readJson(handle.statusFilePath) as Record<string, unknown>;
		const attempts = status["attempts"] as Array<Record<string, unknown>>;
		expect(attempts).toHaveLength(1);
		expect(attempts[0]!["result"]).toBe("replied");
		expect(attempts[0]!["endedAt"]).toBe("2026-04-04T15:30:10.000Z");
		expect(attempts[0]!["outputTail"]).toBe("some output");
	});

	it("atomically updates status.json — no .tmp file left behind", () => {
		const handle = service.createArtifact(BASE_INPUT);
		const tmpPath = `${handle.statusFilePath}.tmp`;

		service.recordAttemptStart({
			artifactHandle: handle,
			attemptNumber: 1,
			submitStrategy: "direct-paste",
			startedAt: "2026-04-04T15:30:05.000Z",
		});

		// The .tmp file should not remain
		expect(fs.existsSync(tmpPath)).toBe(false);
		// The real status file should exist
		expect(fs.existsSync(handle.statusFilePath)).toBe(true);
	});

	it("recordReplied transitions currentState to replied", () => {
		const handle = service.createArtifact(BASE_INPUT);
		service.recordReplied({ artifactHandle: handle, at: "2026-04-04T15:30:20.000Z" });

		const status = readJson(handle.statusFilePath) as Record<string, unknown>;
		expect(status["currentState"]).toBe("replied");
		expect(status["updatedAt"]).toBe("2026-04-04T15:30:20.000Z");

		const transitions = status["transitions"] as Array<Record<string, unknown>>;
		const lastTransition = transitions[transitions.length - 1]!;
		expect(lastTransition["state"]).toBe("replied");
	});

	it("recordConsumed transitions currentState to consumed", () => {
		const handle = service.createArtifact(BASE_INPUT);
		service.recordConsumed({ artifactHandle: handle, at: "2026-04-04T15:30:25.000Z" });

		const status = readJson(handle.statusFilePath) as Record<string, unknown>;
		expect(status["currentState"]).toBe("consumed");
		expect(status["updatedAt"]).toBe("2026-04-04T15:30:25.000Z");

		const transitions = status["transitions"] as Array<Record<string, unknown>>;
		const lastTransition = transitions[transitions.length - 1]!;
		expect(lastTransition["state"]).toBe("consumed");
	});

	it("sweep() deletes terminal-state directories older than 6 hours", () => {
		vi.useFakeTimers();
		try {
			const now = new Date("2026-04-04T15:30:00.000Z");
			vi.setSystemTime(now);

			const handle = service.createArtifact({ ...BASE_INPUT, now: now.toISOString() });
			service.recordConsumed({ artifactHandle: handle, at: now.toISOString() });

			// Advance time past 6 hours
			vi.setSystemTime(new Date("2026-04-04T21:31:00.000Z"));

			service.sweep();

			expect(fs.existsSync(handle.artifactDirPath)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("sweep() deletes replied-state directories older than 6 hours", () => {
		vi.useFakeTimers();
		try {
			const now = new Date("2026-04-04T15:30:00.000Z");
			vi.setSystemTime(now);

			const handle = service.createArtifact({ ...BASE_INPUT, now: now.toISOString() });
			service.recordReplied({ artifactHandle: handle, at: now.toISOString() });

			// Advance time past 6 hours
			vi.setSystemTime(new Date("2026-04-04T21:31:00.000Z"));

			service.sweep();

			expect(fs.existsSync(handle.artifactDirPath)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("sweep() deletes stale pending directories older than 12 hours", () => {
		vi.useFakeTimers();
		try {
			const now = new Date("2026-04-04T10:00:00.000Z");
			vi.setSystemTime(now);

			const handle = service.createArtifact({ ...BASE_INPUT, now: now.toISOString() });
			// leave state as "pending"

			// Advance time past 12 hours
			vi.setSystemTime(new Date("2026-04-04T22:01:00.000Z"));

			service.sweep();

			expect(fs.existsSync(handle.artifactDirPath)).toBe(false);
		} finally {
			vi.useRealTimers();
		}
	});

	it("sweep() does not delete recent artifacts", () => {
		vi.useFakeTimers();
		try {
			const now = new Date("2026-04-04T15:30:00.000Z");
			vi.setSystemTime(now);

			const handle = service.createArtifact({ ...BASE_INPUT, now: now.toISOString() });
			service.recordConsumed({ artifactHandle: handle, at: now.toISOString() });

			// Advance time only 1 hour — still within 6-hour window
			vi.setSystemTime(new Date("2026-04-04T16:30:00.000Z"));

			service.sweep();

			// Directory should still exist
			expect(fs.existsSync(handle.artifactDirPath)).toBe(true);
		} finally {
			vi.useRealTimers();
		}
	});

	it("recordFailed transitions currentState to the given failure state", () => {
		const handle = service.createArtifact(BASE_INPUT);
		service.recordFailed({ artifactHandle: handle, state: "timed_out", at: "2026-04-04T15:30:30.000Z" });

		const status = readJson(handle.statusFilePath) as Record<string, unknown>;
		expect(status["currentState"]).toBe("timed_out");
		expect(status["updatedAt"]).toBe("2026-04-04T15:30:30.000Z");

		const transitions = status["transitions"] as Array<Record<string, unknown>>;
		const lastTransition = transitions[transitions.length - 1]!;
		expect(lastTransition["state"]).toBe("timed_out");
	});

	it("sweep() preserves short normalized plain-text output tails (ANSI stripped, truncated to 200 chars)", () => {
		const handle = service.createArtifact(BASE_INPUT);
		service.recordAttemptStart({
			artifactHandle: handle,
			attemptNumber: 1,
			submitStrategy: "direct-paste",
			startedAt: "2026-04-04T15:30:05.000Z",
		});

		// Include ANSI escape sequences and a long string
		const ansiOutput = "\x1b[32mHello\x1b[0m " + "x".repeat(300);
		service.recordAttemptResult({
			artifactHandle: handle,
			attemptNumber: 1,
			result: "replied",
			endedAt: "2026-04-04T15:30:10.000Z",
			outputTail: ansiOutput,
		});

		const status = readJson(handle.statusFilePath) as Record<string, unknown>;
		const attempts = status["attempts"] as Array<Record<string, unknown>>;
		const storedTail = attempts[0]!["outputTail"] as string;

		// ANSI codes should be stripped
		expect(storedTail).not.toContain("\x1b[");
		// Length should be at most 200
		expect(storedTail.length).toBeLessThanOrEqual(200);
		// Should end with the trailing x's (last 200 chars of stripped string)
		expect(storedTail).toMatch(/^x+$/);
	});
});
