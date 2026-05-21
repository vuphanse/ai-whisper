import { afterEach, describe, expect, it, vi } from "vitest";

describe("buildBrokerDaemonEnv pristine snapshot", () => {
	afterEach(() => {
		delete process.env.AIW_TEST_PRISTINE;
		delete process.env.AIW_TEST_POLLUTION;
		vi.resetModules();
	});

	it("includes env present at import but excludes env set after import", async () => {
		// Set a key before the module is (re-)imported — it must appear in the spawn env.
		process.env.AIW_TEST_PRISTINE = "present-at-import";
		vi.resetModules();
		const mod = await import("../packages/cli/src/runtime/broker-daemon.ts");

		// Simulate whisper.ts's loadDotEnv polluting process.env AFTER module load.
		process.env.AIW_TEST_POLLUTION = "from-workspace-dotenv";

		const env = mod.buildBrokerDaemonEnv("/tmp/x.db", "127.0.0.1", 4311, "c1");

		expect(env.AIW_TEST_PRISTINE).toBe("present-at-import");
		expect(env.AIW_TEST_POLLUTION).toBeUndefined();

		// Explicit AI_WHISPER_* injections still present regardless of snapshot.
		expect(env.AI_WHISPER_COLLAB_ID).toBe("c1");
		expect(env.AI_WHISPER_BROKER_SQLITE).toBe("/tmp/x.db");
		expect(env.AI_WHISPER_BROKER_HOST).toBe("127.0.0.1");
		expect(env.AI_WHISPER_BROKER_PORT).toBe("4311");
	});
});
