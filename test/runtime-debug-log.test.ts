import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRuntimeDebugLogger } from "../packages/cli/src/runtime/runtime-debug-log.ts";

describe("runtime debug log", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("appends structured programmatic PTY write events to the configured log", () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date("2026-04-09T04:05:00.000Z"));

		const logDir = mkdtempSync(join(tmpdir(), "ai-whisper-runtime-log-"));
		const logPath = join(logDir, "input.log");
		const logger = createRuntimeDebugLogger({
			logPath,
			sessionId: "session_codex",
		});

		logger({
			type: "programmatic-write",
			channel: "mounted-submit",
			data: "/copy\r",
		});

		const lines = readFileSync(logPath, "utf8").trim().split("\n");
		expect(lines).toHaveLength(1);
		const [firstLine] = lines;
		expect(firstLine).toBeTruthy();
		const record = JSON.parse(firstLine!) as {
			at: string;
			sessionId: string | null;
			type: string;
			channel: string;
			data: string;
			dataHex: string;
		};
		expect(record.at).toBe("2026-04-09T04:05:00.000Z");
		expect(record.sessionId).toBe("session_codex");
		expect(record.type).toBe("programmatic-write");
		expect(record.channel).toBe("mounted-submit");
		expect(record.data).toBe("/copy\r");
		expect(record.dataHex).toBe(Buffer.from("/copy\r", "utf8").toString("hex"));
	});
});
