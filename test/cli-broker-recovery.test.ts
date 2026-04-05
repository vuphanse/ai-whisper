import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { assessBrokerDaemon } from "../packages/cli/src/runtime/broker-daemon.ts";

describe("cli recovery state", () => {
	it("normalizes v2 state into v3 recovery defaults", () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-recovery-state-"));
		const statePath = join(dir, "current-collab.json");
		writeFileSync(statePath, JSON.stringify({
			version: 2,
			collabId: "collab_v2",
			workspaceRoot: "/tmp/workspace",
			broker: {
				sqlitePath: "/tmp/workspace/.ai-whisper/runtime/broker.sqlite",
				host: "127.0.0.1",
				port: 4311,
				pid: 99123,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: "2026-04-05T15:55:00.000Z",
		}));

		expect(readCliCollabState(statePath)?.recovery).toEqual({
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		});
	});

	it("marks the broker unavailable when pid and health probe both fail", async () => {
		const result = await assessBrokerDaemon({
			host: "127.0.0.1",
			port: 4311,
			pid: 99999,
			fetchImpl: vi.fn(() => Promise.reject(new Error("connect ECONNREFUSED"))) as never,
			killImpl: vi.fn(() => {
				throw new Error("no such process");
			}) as never,
		});

		expect(result).toEqual({
			pidAlive: false,
			httpReachable: false,
			ok: false,
		});
	});
});
