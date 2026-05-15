import { describe, expect, it, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";
import { getStateRoot, getSharedSqlitePath } from "../packages/cli/src/runtime/state-root.ts";

describe("state-root", () => {
	const originalEnv = process.env.AI_WHISPER_STATE_ROOT;

	beforeEach(() => {
		delete process.env.AI_WHISPER_STATE_ROOT;
	});
	afterEach(() => {
		if (originalEnv !== undefined) process.env.AI_WHISPER_STATE_ROOT = originalEnv;
		else delete process.env.AI_WHISPER_STATE_ROOT;
	});

	it("defaults to ~/.ai-whisper when env var unset", () => {
		expect(getStateRoot()).toBe(path.join(os.homedir(), ".ai-whisper"));
	});

	it("uses AI_WHISPER_STATE_ROOT when set", () => {
		process.env.AI_WHISPER_STATE_ROOT = "/tmp/test-root";
		expect(getStateRoot()).toBe("/tmp/test-root");
	});

	it("returns state.db under the resolved root", () => {
		process.env.AI_WHISPER_STATE_ROOT = "/tmp/x";
		expect(getSharedSqlitePath()).toBe("/tmp/x/state.db");
	});
});
