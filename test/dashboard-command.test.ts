import { describe, expect, it, vi } from "vitest";
import { PassThrough } from "node:stream";
import { runCollabDashboard } from "../packages/cli/src/commands/collab/dashboard.ts";

describe("runCollabDashboard", () => {
	it("builds a broker, runs the dashboard runtime, stops on SIGINT-equivalent", async () => {
		const stop = vi.fn(async () => {});
		const waitUntilStopped = vi.fn(async () => {});
		const start = vi.fn();
		const fakeRuntime = { start, stop, waitUntilStopped };
		const brokerStop = vi.fn(async () => {});
		await runCollabDashboard({
			stdout: new PassThrough() as unknown as NodeJS.WritableStream,
			__createBroker: () => ({ stop: brokerStop }) as never,
			__createRuntime: () => fakeRuntime as never,
			__noSignals: true,
		});
		expect(start).toHaveBeenCalledTimes(1);
		expect(waitUntilStopped).toHaveBeenCalledTimes(1);
		expect(brokerStop).toHaveBeenCalledTimes(1);
	});
});
