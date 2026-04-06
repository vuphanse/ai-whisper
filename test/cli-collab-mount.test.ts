import { describe, expect, it } from "vitest";
import { attachClaimSchema, sessionBindingSchema } from "../packages/shared/src/index.ts";
import { readCliCollabState, writeCliCollabState } from "../packages/cli/src/runtime/state-file.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

describe("mounted shared state", () => {
	it("accepts mounted binding sources and mount_current_tty claims", () => {
		const binding = sessionBindingSchema.parse({
			version: 1,
			collabId: "collab_mount",
			agentType: "codex",
			bindingState: "bound",
			activeSessionId: "session_codex_mount",
			bindingSource: "mounted",
			targetTtyPath: "/dev/ttys031",
			pendingClaimId: null,
			pendingClaimExpiresAt: null,
			updatedAt: "2026-04-06T08:00:00.000Z",
		});

		const claim = attachClaimSchema.parse({
			version: 1,
			claimId: "claim_mount_1",
			collabId: "collab_mount",
			agentType: "codex",
			mode: "attach",
			targetMode: "mount_current_tty",
			targetTtyPath: "/dev/ttys031",
			secret: "secret_mount",
			status: "pending",
			createdAt: "2026-04-06T08:00:00.000Z",
			expiresAt: "2026-04-06T08:05:00.000Z",
			consumedAt: null,
		});

		expect(binding.bindingSource).toBe("mounted");
		expect(claim.targetMode).toBe("mount_current_tty");
	});

	it("round-trips mounted runtime metadata in local state", () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-mounted-state-"));
		const path = join(dir, "current-collab.json");

		writeCliCollabState(path, {
			version: 5,
			collabId: "collab_mount",
			workspaceRoot: dir,
			broker: { sqlitePath: join(dir, "broker.sqlite"), host: "127.0.0.1", port: 4311, pid: 99123 },
			launch: { mode: "none" },
			ownedSessions: {},
			startedAt: "2026-04-06T08:00:00.000Z",
			recovery: { state: "normal", idleAfterRecovery: false, recoveredAt: null },
			adoptedSessions: {},
			mountedSessions: {
				codex: {
					agentType: "codex",
					ttyPath: "/dev/ttys031",
					sessionPid: 99234,
				},
			},
		});

		expect(readCliCollabState(path)?.mountedSessions.codex?.ttyPath).toBe("/dev/ttys031");
	});
});
