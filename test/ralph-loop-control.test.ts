import { describe, expect, it } from "vitest";
import { join } from "node:path";
import { ralphRunDir } from "../packages/broker/src/runtime/workflow-registry.ts";

describe("ralphRunDir", () => {
	it("joins workspace + .ai-whisper/ralph/<workflowId>", () => {
		expect(ralphRunDir("/ws", "wf_123")).toBe(join("/ws", ".ai-whisper", "ralph", "wf_123"));
	});
});
