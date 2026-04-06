import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	formatRelayConversationLine,
	formatStatusPanel,
} from "../packages/cli/src/runtime/relay-monitor.ts";

describe("relay monitor", () => {
	describe("formatRelayConversationLine", () => {
		it("formats relay directive with direction header and body on new line", () => {
			const output = formatRelayConversationLine({
				eventType: "relay_directive",
				senderAgent: "claude",
				receiverAgent: "codex",
				content: "review the implementation",
				createdAt: "2026-04-06T15:42:15.000Z",
				isLatest: true,
			});

			expect(output).toContain("15:42:15");
			expect(output).toContain("[claude]");
			expect(output).toContain("[codex]");
			expect(output).toContain("→");
			expect(output).toContain("review the implementation");
			expect(output).toContain("LATEST");
		});

		it("formats relay response with body on new line", () => {
			const output = formatRelayConversationLine({
				eventType: "relay_response",
				senderAgent: "codex",
				receiverAgent: "claude",
				content: "Found 3 issues:\n1) Missing error handling\n2) No validation",
				createdAt: "2026-04-06T15:42:31.000Z",
				isLatest: false,
			});

			expect(output).toContain("[codex]");
			expect(output).toContain("[claude]");
			// Body should be on separate lines, indented
			const lines = output.split("\n");
			expect(lines.length).toBeGreaterThan(1);
			expect(lines[1]).toMatch(/^\s+Found 3 issues:/);
		});

		it("formats status event dimly", () => {
			const output = formatRelayConversationLine({
				eventType: "status",
				senderAgent: null,
				receiverAgent: null,
				content: "Collab started, sessions bound",
				createdAt: "2026-04-06T15:40:01.000Z",
				isLatest: false,
			});

			expect(output).toContain("15:40:01");
			expect(output).toContain("Collab started");
			// Should contain dim ANSI code
			expect(output).toContain("\u001b[2m");
		});
	});

	describe("formatStatusPanel", () => {
		it("renders provider health and collab state", () => {
			const output = formatStatusPanel({
				providers: [
					{ name: "claude", health: "online" },
					{ name: "codex", health: "relay_work" },
				],
				collabState: "active",
				threadCount: 1,
				activeThreadTitle: "impl review",
				uptime: "2m15s",
				lastRelayAge: "15s ago",
			});

			expect(output).toContain("claude");
			expect(output).toContain("codex");
			expect(output).toContain("active");
			expect(output).toContain("impl review");
		});
	});
});
