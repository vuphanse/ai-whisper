import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import { createRelayPaneWriter } from "../packages/cli/src/runtime/relay-pane-writer.ts";

describe("relay pane writer", () => {
	function createTestBroker() {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-rpw-"));
		const broker = createBrokerRuntime({
			sqlitePath: join(dir, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4311,
		});
		broker.control.startCollab({
			collabId: "collab_1",
			workspaceRoot: "/tmp/test",
			displayName: "test",
			now: "2026-04-06T00:00:00.000Z",
		});
		return broker;
	}

	it("writes relay directive event to broker", () => {
		const broker = createTestBroker();
		const writer = createRelayPaneWriter({ broker, collabId: "collab_1" });

		writer.relayDirective({
			senderAgent: "claude",
			receiverAgent: "codex",
			instruction: "review the implementation",
			now: "2026-04-06T00:01:00.000Z",
		});

		const events = broker.control.pollRelayEvents("collab_1", 0);
		expect(events).toHaveLength(1);
		expect(events[0]!.eventType).toBe("relay_directive");
		expect(events[0]!.senderAgent).toBe("claude");
		expect(events[0]!.receiverAgent).toBe("codex");
		expect(events[0]!.content).toBe("review the implementation");
	});

	it("writes relay response event to broker", () => {
		const broker = createTestBroker();
		const writer = createRelayPaneWriter({ broker, collabId: "collab_1" });

		writer.relayResponse({
			senderAgent: "codex",
			receiverAgent: "claude",
			content: "Found 3 issues",
			now: "2026-04-06T00:02:00.000Z",
		});

		const events = broker.control.pollRelayEvents("collab_1", 0);
		expect(events).toHaveLength(1);
		expect(events[0]!.eventType).toBe("relay_response");
		expect(events[0]!.senderAgent).toBe("codex");
		expect(events[0]!.receiverAgent).toBe("claude");
		expect(events[0]!.content).toBe("Found 3 issues");
	});

	it("writes status event to broker", () => {
		const broker = createTestBroker();
		const writer = createRelayPaneWriter({ broker, collabId: "collab_1" });

		writer.status({ content: "Collab started, sessions bound", now: "2026-04-06T00:00:00.000Z" });

		const events = broker.control.pollRelayEvents("collab_1", 0);
		expect(events).toHaveLength(1);
		expect(events[0]!.eventType).toBe("status");
		expect(events[0]!.content).toBe("Collab started, sessions bound");
	});

	it("writes cancellation event to broker", () => {
		const broker = createTestBroker();
		const writer = createRelayPaneWriter({ broker, collabId: "collab_1" });

		writer.cancellation({
			agent: "codex",
			content: "relay work cancelled by user",
			now: "2026-04-06T00:02:00.000Z",
		});

		const events = broker.control.pollRelayEvents("collab_1", 0);
		expect(events).toHaveLength(1);
		expect(events[0]!.eventType).toBe("cancellation");
		expect(events[0]!.senderAgent).toBe("codex");
	});
});
