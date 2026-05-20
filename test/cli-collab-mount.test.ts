import { describe, expect, it } from "vitest";
import { attachClaimSchema, sessionBindingSchema } from "../packages/shared/src/index.ts";

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
});
