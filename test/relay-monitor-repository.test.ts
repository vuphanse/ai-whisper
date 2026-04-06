import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

describe("relay monitor repository", () => {
	function createTestBroker() {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-relay-monitor-"));
		return createBrokerRuntime({
			sqlitePath: join(dir, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4311,
		});
	}

	it("registers a relay monitor and checks connectivity", () => {
		const broker = createTestBroker();
		broker.control.startCollab({
			collabId: "collab_1",
			workspaceRoot: "/tmp/test",
			displayName: "test",
			now: "2026-04-06T00:00:00.000Z",
		});

		expect(broker.control.isRelayMonitorConnected("collab_1")).toBe(false);

		broker.control.registerRelayMonitor({
			collabId: "collab_1",
			monitorId: "monitor_1",
			now: "2026-04-06T00:00:00.000Z",
		});

		expect(broker.control.isRelayMonitorConnected("collab_1")).toBe(true);
	});

	it("detects stale relay monitor after heartbeat timeout", () => {
		const broker = createTestBroker();
		broker.control.startCollab({
			collabId: "collab_1",
			workspaceRoot: "/tmp/test",
			displayName: "test",
			now: "2026-04-06T00:00:00.000Z",
		});

		broker.control.registerRelayMonitor({
			collabId: "collab_1",
			monitorId: "monitor_1",
			now: "2026-04-06T00:00:00.000Z",
		});

		// 30 seconds later — still connected (threshold is 60s)
		expect(
			broker.control.isRelayMonitorConnected("collab_1", "2026-04-06T00:00:30.000Z"),
		).toBe(true);

		// 90 seconds later with no heartbeat — stale
		expect(
			broker.control.isRelayMonitorConnected("collab_1", "2026-04-06T00:01:30.000Z"),
		).toBe(false);
	});

	it("heartbeat updates last_heartbeat_at", () => {
		const broker = createTestBroker();
		broker.control.startCollab({
			collabId: "collab_1",
			workspaceRoot: "/tmp/test",
			displayName: "test",
			now: "2026-04-06T00:00:00.000Z",
		});

		broker.control.registerRelayMonitor({
			collabId: "collab_1",
			monitorId: "monitor_1",
			now: "2026-04-06T00:00:00.000Z",
		});

		broker.control.heartbeatRelayMonitor({
			collabId: "collab_1",
			monitorId: "monitor_1",
			now: "2026-04-06T00:01:00.000Z",
		});

		// 90 seconds after registration but only 30s after heartbeat — still connected
		expect(
			broker.control.isRelayMonitorConnected("collab_1", "2026-04-06T00:01:30.000Z"),
		).toBe(true);
	});
});
