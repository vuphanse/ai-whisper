import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("phase 6 manual smoke script", () => {
	it("prints usage information", () => {
		const scriptPath = resolve(
			process.cwd(),
			"scripts/manual/phase-6-live-session-smoke.sh",
		);
		const output = execFileSync("bash", [scriptPath, "--help"], {
			cwd: process.cwd(),
			encoding: "utf8",
		});

		expect(output).toContain("Usage:");
		expect(output).toContain("--provider");
		expect(output).toContain("--mode");
		expect(output).toContain("--message");
		expect(output).toContain("--attempt");
		expect(output).toContain("--probe-payload");
		expect(output).toContain("--workspace");
		expect(output).toContain("framed-minimal");
		expect(output).toContain("broker-current");
	});

	it("broker-current probe mode is labeled debug-only in the shell script", () => {
		const scriptPath = resolve(
			process.cwd(),
			"scripts/manual/phase-6-live-session-smoke.sh",
		);
		const source = readFileSync(scriptPath, "utf8");

		// Verify the debug-only marker is present for probe payload modes
		expect(source).toContain("DEBUG ONLY");
	});

	it("broker-current probe mode writes a file-backed request artifact in the mjs script", () => {
		const scriptPath = resolve(
			process.cwd(),
			"scripts/manual/phase-6-live-session-smoke.mjs",
		);
		const source = readFileSync(scriptPath, "utf8");

		// The broker-current path must NOT use the old inline request object shape.
		// It must write a request.json file and pass a requestFilePath to the prompt builder.
		expect(source).toContain("request.json");
		// requestFilePath must be used somewhere in the broker-current path
		expect(source).toContain("requestFilePath");

		// Old signature was: buildCodexInteractiveBrokerPrompt({ workItemId, ... }) — inline request object
		expect(source).not.toContain("buildCodexInteractiveBrokerPrompt({");
		expect(source).not.toContain("buildClaudeInteractiveBrokerPrompt({");

		// Ensure the inline old single-arg signature is not used in broker-current
		// (old: buildCodexInteractiveBrokerPrompt(request) where request is an object)
		expect(source).not.toContain("buildCodexInteractiveBrokerPrompt(request)");
		expect(source).not.toContain("buildClaudeInteractiveBrokerPrompt(request)");

		// The broker-current block must be labeled as debug-only
		expect(source).toContain("DEBUG ONLY");
	});

	it("broker mode in the mjs script uses one-shot provider execution", () => {
		const scriptPath = resolve(
			process.cwd(),
			"scripts/manual/phase-6-live-session-smoke.mjs",
		);
		const source = readFileSync(scriptPath, "utf8");

		// Broker mode must use the provider's one-shot execution path
		expect(source).toContain("provider.handleWork");
		expect(source).toContain("provider.handleWork(request, { artifactHandle })");
		expect(source).toContain("provider.attachInteractiveSession?.(session)");

		// Must NOT use the retired PTY broker execution path
		expect(source).not.toContain("runBrokerWork");
	});
});
