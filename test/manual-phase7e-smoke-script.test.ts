import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("phase 7e manual smoke script", () => {
	it("documents mount, automatic provider launch, and inline relay", () => {
		const script = readFileSync(resolve(root, "scripts/manual/phase-7e-mounted-session-smoke.sh"), "utf8");
		expect(script).toContain("node packages/cli/dist/bin/whisper.js collab mount");
		expect(script).toContain("node packages/cli/dist/bin/whisper.js collab status");
		expect(script).toContain("@@codex");
		expect(script).toContain("@@claude");
		expect(script).toContain("[mounted]");
	});

	it("points operators to the mounted handoff probe harness", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7e-mounted-session-smoke.sh"),
			"utf8",
		);
		expect(script).toContain("phase-7e-mounted-turn-handoff-probe.sh");
		expect(script).toContain("AI_WHISPER_DEBUG_INPUT_LOG");
	});
});

describe("phase 7e mounted handoff probe script", () => {
	it("prints usage information for the mounted handoff probe", () => {
		const scriptPath = resolve(
			root,
			"scripts/manual/phase-7e-mounted-turn-handoff-probe.sh",
		);
		const output = execFileSync("bash", [scriptPath, "--help"], {
			cwd: root,
			encoding: "utf8",
		});

		expect(output).toContain("Usage:");
		expect(output).toContain("--source");
		expect(output).toContain("--target");
		expect(output).toContain("--message");
		expect(output).toContain("--amend-line");
		expect(output).toContain("--wait-before-handback-ms");
		expect(output).toContain("--wait-after-source-response-ms");
		expect(output).toContain("--reset-runtime");
		expect(output).toContain("--no-build");
	});

	it("enables mounted provider input logging for both sides", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7e-mounted-turn-handoff-probe.sh"),
			"utf8",
		);
		expect(script).toContain("AI_WHISPER_DEBUG_INPUT_LOG");
		expect(script).toContain("collab relay-monitor");
		expect(script).toContain("collab mount");
	});

	it("produces a pass/fail verdict from the captured mounted-flow artifacts", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7e-mounted-turn-handoff-probe.sh"),
			"utf8",
		);
		expect(script).toContain("PROBE_OK=1");
		expect(script).toContain("Probe verdict: PASS");
		expect(script).toContain("Probe verdict: FAIL");
		expect(script).toContain("programmatic-write");
		expect(script).toContain("source receives returned handoff card");
		expect(script).toContain("after-handback-confirm");
		expect(script).toContain("Is this a good joke?");
		expect(script).toContain("source log records amended handoff text");
		expect(script).toContain("after-amend-response.txt");
	});

	it("uses the shared-DB probe helper for cleanup and drops the fixed-port guard", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7e-mounted-turn-handoff-probe.sh"),
			"utf8",
		);
		expect(script).toContain(
			'source "$REPO_ROOT/scripts/manual/_probe-shared-db.sh"',
		);
		expect(script).toContain("probe_stop_if_active");
		expect(script).toContain("probe_reset_runtime");
		// migrated off per-workspace runtime files and the fixed-port preflight
		expect(script).not.toContain('rm -f "$STATE_FILE" "$SQLITE_FILE"');
		expect(script).not.toContain("lsof -n -P -iTCP:4311 -sTCP:LISTEN");
	});
});

describe("README mount guidance", () => {
	it("documents mount as the inline relay path", () => {
		const readme = readFileSync(resolve(root, "README.md"), "utf8");
		expect(readme).toContain("whisper collab mount");
		expect(readme).toContain("inline `@@` relay");
	});
});
