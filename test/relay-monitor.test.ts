import { describe, expect, it } from "vitest";
import {
	formatRelayConversationLine,
	formatStatusPanel,
	renderRelayConversationBatch,
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
			// Should contain dim ANSI code plus gray status styling
			expect(output).toContain("\u001b[2m");
			expect(output).toContain("\u001b[38;5;244m");
		});

		it("clears the previous latest badge before rendering a newer event", () => {
			const output = renderRelayConversationBatch({
				previousLatestEvent: {
					id: 1,
					eventType: "relay_response",
					senderAgent: "codex",
					receiverAgent: "claude",
					content: "Why do programmers prefer dark mode?",
					createdAt: "2026-04-06T14:57:15.000Z",
				},
				events: [
					{
						id: 2,
						eventType: "relay_directive",
						senderAgent: "codex",
						receiverAgent: "claude",
						content: "can you make fun of me?",
						createdAt: "2026-04-06T14:57:41.000Z",
					},
				],
			});

			expect(output).toContain("\u001b7");
			expect(output).toContain("\u001b[2A");
			expect(output).toContain("\r\u001b[2K");
			expect(output).toContain("can you make fun of me?");
			expect(output.match(/LATEST/g) ?? []).toHaveLength(1);

			const rewriteSegment = output.split("\u001b8")[0]!;
			expect(rewriteSegment).toContain("[codex]");
			expect(rewriteSegment).not.toContain("LATEST");
		});

		it("renders batches without blank spacer lines between entries", () => {
			const output = renderRelayConversationBatch({
				previousLatestEvent: null,
				events: [
					{
						id: 1,
						eventType: "relay_directive",
						senderAgent: "claude",
						receiverAgent: "codex",
						content: "give me a joke",
						createdAt: "2026-04-06T14:56:42.000Z",
					},
					{
						id: 2,
						eventType: "status",
						senderAgent: null,
						receiverAgent: null,
						content: "[ai-whisper] Started new thread and relayed to codex.",
						createdAt: "2026-04-06T14:56:42.000Z",
					},
				],
			});

			expect(output).not.toContain("\n\n");
			expect(output).toContain("give me a joke");
			expect(output).toContain("Started new thread");
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
				turnOwner: "none",
				waitingAgent: null,
				handoffState: "idle",
			});

			expect(output).toContain("claude");
			expect(output).toContain("codex");
			expect(output).toContain("active");
			expect(output).toContain("impl review");
		});

		it("renders turn owner, waiting side, and stale handoff state", () => {
			const output = formatStatusPanel({
				providers: [
					{ name: "claude", health: "online" },
					{ name: "codex", health: "online" },
				],
				collabState: "active",
				threadCount: 1,
				activeThreadTitle: "turn handoff",
				uptime: "5m",
				lastRelayAge: "2m ago",
				turnOwner: "claude",
				waitingAgent: "codex",
				handoffState: "stale_handoff",
			});

			expect(output).toContain("Turn owner: claude");
			expect(output).toContain("Waiting: codex");
			expect(output).toContain("stale handoff");
		});
	});
});
