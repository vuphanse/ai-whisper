import { spawn } from "node:child_process";
import { describe, expect, it, vi } from "vitest";

vi.mock("node:child_process", () => ({
	spawn: vi.fn(),
}));

import { resolveBrokerDaemonLaunch, spawnBrokerDaemon } from "../packages/cli/src/runtime/broker-daemon.ts";

/**
 * Calls spawnBrokerDaemon with a mocked spawn and returns the env that was
 * passed to the spawned process.
 */
function captureSpawnBrokerDaemon(
	sqlitePath: string,
	host: string,
	port: number,
	collabId: string,
): { env: Record<string, string | undefined> } {
	const spawnMock = vi.mocked(spawn);
	const fakeChild = { unref: vi.fn(), pid: 12345 };
	spawnMock.mockReturnValueOnce(fakeChild as never);

	spawnBrokerDaemon(sqlitePath, host, port, collabId);

	const calls = spawnMock.mock.calls;
	const lastCall = calls[calls.length - 1];
	const spawnOptions = lastCall[2] as { env: Record<string, string | undefined> };

	return { env: { ...spawnOptions.env } };
}

describe("broker daemon runtime", () => {
	it("resolves source-tree broker daemon through tsx loader", () => {
		const launch = resolveBrokerDaemonLaunch();

		expect(launch.command).toBe(process.execPath);
		expect(launch.args).toHaveLength(3);
		expect(launch.args[0]).toBe("--import");
		expect(launch.args[1]).toBe("tsx");
		expect(launch.args[2]).toMatch(/packages\/cli\/src\/bin\/broker-daemon\.ts$/);
	});

	it("passes collab id through broker daemon launch env", () => {
		const launch = captureSpawnBrokerDaemon("broker.sqlite", "127.0.0.1", 4311, "collab_123");
		expect(launch.env.AI_WHISPER_COLLAB_ID).toBe("collab_123");
	});
});
