import { describe, expect, it } from "vitest";
import {
	sessionBindingSchema,
	attachClaimSchema,
} from "../packages/shared/src/index.ts";
import {
	readCliCollabState,
	writeCliCollabState,
} from "../packages/cli/src/runtime/state-file.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
