import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";

describe("relay event repository", () => {
	function createTestBroker() {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-relay-event-"));
		return createBrokerRuntime({
			sqlitePath: join(dir, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4311,
		});
	}

	it("appends and polls relay events by cursor", () => {
		const broker = createTestBroker();
		broker.control.startCollab({
			collabId: "collab_1",
			workspaceRoot: "/tmp/test",
			displayName: "test",
			now: "2026-04-06T00:00:00.000Z",
		});

		broker.control.appendRelayEvent({
			collabId: "collab_1",
			eventType: "relay_directive",
			senderAgent: "claude",
			receiverAgent: "codex",
			content: "review the implementation",
			now: "2026-04-06T00:01:00.000Z",
		});

		broker.control.appendRelayEvent({
			collabId: "collab_1",
			eventType: "relay_response",
			senderAgent: "codex",
			receiverAgent: "claude",
			content: "Found 3 issues",
			now: "2026-04-06T00:01:30.000Z",
		});

		// Poll from beginning
		const all = broker.control.pollRelayEvents("collab_1", 0);
		expect(all).toHaveLength(2);
		expect(all[0].eventType).toBe("relay_directive");
		expect(all[0].content).toBe("review the implementation");
		expect(all[1].eventType).toBe("relay_response");

		// Poll from after first event
		const afterFirst = broker.control.pollRelayEvents("collab_1", all[0].id);
		expect(afterFirst).toHaveLength(1);
		expect(afterFirst[0].content).toBe("Found 3 issues");
	});

	it("appends status events", () => {
		const broker = createTestBroker();
		broker.control.startCollab({
			collabId: "collab_1",
			workspaceRoot: "/tmp/test",
			displayName: "test",
			now: "2026-04-06T00:00:00.000Z",
		});

		broker.control.appendRelayEvent({
			collabId: "collab_1",
			eventType: "status",
			senderAgent: null,
			receiverAgent: null,
			content: "Collab started, sessions bound",
			now: "2026-04-06T00:00:00.000Z",
		});

		const events = broker.control.pollRelayEvents("collab_1", 0);
		expect(events).toHaveLength(1);
		expect(events[0].eventType).toBe("status");
		expect(events[0].senderAgent).toBeNull();
	});
});
