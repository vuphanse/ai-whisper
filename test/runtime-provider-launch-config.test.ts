import { describe, expect, it } from "vitest";
import { getLiveSessionBrokerTempRoot } from "../packages/cli/src/runtime/paths.ts";
import {
	getInteractiveSessionExecArgsForTarget,
	getProviderExecArgsForTarget,
} from "../packages/cli/src/runtime/providers.ts";

describe("interactive session launch config", () => {
	it("grants codex a writable sandbox and access to the broker temp root", () => {
		expect(getInteractiveSessionExecArgsForTarget("codex")).toEqual([
			"--sandbox",
			"workspace-write",
			"--add-dir",
			getLiveSessionBrokerTempRoot(),
		]);
	});

	it("grants claude access to the broker temp root and disables permission prompts", () => {
		expect(getInteractiveSessionExecArgsForTarget("claude")).toEqual([
			"--add-dir",
			getLiveSessionBrokerTempRoot(),
			"--permission-mode",
			"dontAsk",
		]);
	});
});

describe("one-shot provider launch config", () => {
	it("grants codex one-shot execution a writable sandbox and access to the broker temp root", () => {
		expect(getProviderExecArgsForTarget("codex")).toEqual([
			"exec",
			"--sandbox",
			"workspace-write",
			"--add-dir",
			getLiveSessionBrokerTempRoot(),
		]);
	});

	it("grants claude one-shot execution access to the broker temp root and disables permission prompts", () => {
		expect(getProviderExecArgsForTarget("claude")).toEqual([
			"-p",
			"--add-dir",
			getLiveSessionBrokerTempRoot(),
			"--permission-mode",
			"dontAsk",
		]);
	});
});
