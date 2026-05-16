import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { buildBrokerDaemonEnv } from "../packages/cli/src/runtime/broker-daemon.ts";

// Regression guard for the env-var contract that wires the spawned daemon to
// its collab identity. The spawn env, the daemon entrypoint's PID self-write,
// and the heartbeat thread must all agree on ONE key name. A mismatch here
// silently breaks `whisper collab start`/`recover` in production (the daemon
// never writes its pid, readiness times out, the collab is marked stopped).

const COLLAB_ID_ENV_KEY = "AI_WHISPER_COLLAB_ID";

describe("broker daemon env contract", () => {
	it("spawn env carries the collab id under AI_WHISPER_COLLAB_ID", () => {
		const env = buildBrokerDaemonEnv("/tmp/state.db", "127.0.0.1", 4500, "collab_123");
		expect(env[COLLAB_ID_ENV_KEY]).toBe("collab_123");
	});

	it("bin/broker-daemon.ts reads the same key for the PID self-write", () => {
		const src = readFileSync(
			join(process.cwd(), "packages/cli/src/bin/broker-daemon.ts"),
			"utf8",
		);
		expect(src).toContain(`process.env.${COLLAB_ID_ENV_KEY}`);
		expect(src).toContain("writeOwnPidToBrokerDaemon");
		// The stale, never-set key must not gate the PID write again.
		expect(src).not.toContain("AI_WHISPER_DAEMON_COLLAB_ID");
	});

	it("create-broker-runtime.ts gates the heartbeat on the same key", () => {
		const src = readFileSync(
			join(process.cwd(), "packages/broker/src/runtime/create-broker-runtime.ts"),
			"utf8",
		);
		expect(src).toContain(`process.env.${COLLAB_ID_ENV_KEY}`);
		expect(src).not.toContain("AI_WHISPER_DAEMON_COLLAB_ID");
	});
});
