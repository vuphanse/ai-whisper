import { afterEach, describe, expect, it, vi } from "vitest";

// Hoisted so the vi.mock factory (itself hoisted) can reference it.
const { startMock } = vi.hoisted(() => ({ startMock: vi.fn() }));

// Partial-mock: replace runWorkflowStart, keep parseCallerAgent REAL so the test
// exercises the genuine AI_WHISPER_AGENT → callerAgent mapping at the boundary.
vi.mock("../packages/cli/src/commands/workflow/start.ts", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("../packages/cli/src/commands/workflow/start.ts")>();
	return { ...actual, runWorkflowStart: startMock };
});

vi.mock("../packages/cli/src/runtime/broker-connect.ts", () => ({
	connectToWorkspaceBroker: async () => ({
		broker: { stop: async () => {} },
		collabId: "collab_x",
	}),
}));

import { createCli } from "../packages/cli/src/create-cli.ts";

afterEach(() => {
	startMock.mockReset();
	delete process.env.AI_WHISPER_AGENT;
	vi.restoreAllMocks();
});

async function runStart() {
	await createCli().parseAsync([
		"node",
		"whisper",
		"workflow",
		"start",
		"--type=spec-driven-development",
		"--spec=/tmp/s.md",
		"--workspace=/tmp",
	]);
}

describe("workflow start CLI caller wiring", () => {
	it("forwards AI_WHISPER_AGENT as callerAgent", async () => {
		process.env.AI_WHISPER_AGENT = "codex";
		startMock.mockResolvedValue({ workflowId: "wf_1" });
		await runStart();
		expect(startMock).toHaveBeenCalledWith(expect.objectContaining({ callerAgent: "codex" }));
	});

	it("passes callerAgent=null for an unset/invalid AI_WHISPER_AGENT", async () => {
		process.env.AI_WHISPER_AGENT = "bogus";
		startMock.mockResolvedValue({ workflowId: "wf_2" });
		await runStart();
		expect(startMock).toHaveBeenCalledWith(expect.objectContaining({ callerAgent: null }));
	});

	it("prints roleWarning to stderr and keeps stdout to the parseable line", async () => {
		startMock.mockResolvedValue({
			workflowId: "wf_3",
			roleWarning: "No triggering agent detected; defaulted to implementer=claude / reviewer=codex.",
		});
		const out = vi.spyOn(console, "log").mockImplementation(() => {});
		const err = vi.spyOn(console, "error").mockImplementation(() => {});
		await runStart();
		expect(out).toHaveBeenCalledTimes(1);
		expect(out).toHaveBeenCalledWith("Workflow started: wf_3");
		expect(err).toHaveBeenCalledWith(expect.stringMatching(/no triggering agent detected/i));
		// stdout must NOT carry the warning (skills parse stdout).
		expect(out.mock.calls.flat().join("\n")).not.toMatch(/no triggering agent detected/i);
	});
});
