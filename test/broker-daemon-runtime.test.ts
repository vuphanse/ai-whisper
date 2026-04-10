import { describe, expect, it } from "vitest";
import { resolveBrokerDaemonLaunch } from "../packages/cli/src/runtime/broker-daemon.ts";

describe("broker daemon runtime", () => {
	it("resolves source-tree broker daemon through tsx loader", () => {
		const launch = resolveBrokerDaemonLaunch();

		expect(launch.command).toBe(process.execPath);
		expect(launch.args).toHaveLength(3);
		expect(launch.args[0]).toBe("--import");
		expect(launch.args[1]).toBe("tsx");
		expect(launch.args[2]).toMatch(/packages\/cli\/src\/bin\/broker-daemon\.ts$/);
	});
});
