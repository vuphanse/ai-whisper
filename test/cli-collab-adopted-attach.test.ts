import { describe, expect, it, vi } from "vitest";
import {
	sessionBindingSchema,
	attachClaimSchema,
} from "../packages/shared/src/index.ts";
import {
	readCliCollabState,
	writeCliCollabState,
} from "../packages/cli/src/runtime/state-file.ts";
import { runCollabAttach } from "../packages/cli/src/commands/collab/attach.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const assessBroker = vi.fn(() =>
	Promise.resolve({ pidAlive: true as const, httpReachable: true as const, ok: true as const }),
);

describe("adopted session schemas", () => {
	it("accepts adopted binding metadata", () => {
		const parsed = sessionBindingSchema.parse({
			version: 1,
			collabId: "collab_adopted",
			agentType: "codex",
			bindingState: "bound",
			activeSessionId: "session_codex_1",
			bindingSource: "adopted",
			targetTtyPath: "/dev/ttys012",
			pendingClaimId: null,
			pendingClaimExpiresAt: null,
			updatedAt: "2026-04-06T16:00:00.000Z",
		});

		expect(parsed.bindingSource).toBe("adopted");
		expect(parsed.targetTtyPath).toBe("/dev/ttys012");
	});

	it("accepts adopted attach claim metadata", () => {
		const parsed = attachClaimSchema.parse({
			version: 1,
			claimId: "claim_adopted_1",
			collabId: "collab_adopted",
			agentType: "codex",
			mode: "attach",
			targetMode: "adopt_current_tty",
			targetTtyPath: "/dev/ttys012",
			secret: "secret_123",
			status: "pending",
			createdAt: "2026-04-06T16:00:00.000Z",
			expiresAt: "2026-04-06T16:05:00.000Z",
			consumedAt: null,
		});

		expect(parsed.targetMode).toBe("adopt_current_tty");
	});
});

describe("cli state adopted sessions", () => {
	it("round-trips adopted daemon metadata in local state", () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-adopted-state-"));
		const path = join(dir, "current-collab.json");

		writeCliCollabState(path, {
			version: 4,
			collabId: "collab_adopted",
			workspaceRoot: dir,
			broker: {
				sqlitePath: join(dir, "broker.sqlite"),
				host: "127.0.0.1",
				port: 4311,
				pid: 99123,
			},
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: "2026-04-06T16:00:00.000Z",
			recovery: {
				state: "normal",
				idleAfterRecovery: false,
				recoveredAt: null,
			},
			adoptedSessions: {
				codex: {
					ttyPath: "/dev/ttys012",
					daemonPid: 99234,
					agentType: "codex",
				},
			},
		});

		const state = readCliCollabState(path);
		expect(state?.adoptedSessions.codex?.ttyPath).toBe("/dev/ttys012");
		expect(state?.adoptedSessions.codex?.daemonPid).toBe(99234);
	});
});

describe("collab attach adopted current tty", () => {
	it("starts a detached adoption daemon and returns without printing a foreground snippet", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-adopt-current-tty-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-06T16:30:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
		});

		const startDaemon = vi.fn(() => 99234);

		const result = await runCollabAttach({
			workspaceRoot,
			target: "codex",
			now: "2026-04-06T16:31:00.000Z",
			targetMode: "adopt_current_tty",
			resolveCurrentTty: () => "/dev/ttys012",
			startAdoptionDaemon: startDaemon,
			assessBroker,
		});

		expect(result.mode).toBe("adopted");
		if (result.mode !== "adopted") throw new Error("unreachable");
		expect(result.ttyPath).toBe("/dev/ttys012");
		expect(result.daemonPid).toBe(99234);

		expect(startDaemon).toHaveBeenCalledWith(
			expect.objectContaining({
				target: "codex",
				workspaceRoot,
				ttyPath: "/dev/ttys012",
			}),
		);
	});

	it("falls back to snippet mode when no targetMode is specified", async () => {
		const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-adopt-fallback-"));
		await runCollabStart({
			workspaceRoot,
			now: "2026-04-06T16:30:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
		});

		const result = await runCollabAttach({
			workspaceRoot,
			target: "codex",
			now: "2026-04-06T16:31:00.000Z",
			assessBroker,
		});

		expect(result.mode).toBe("snippet");
	});
});
