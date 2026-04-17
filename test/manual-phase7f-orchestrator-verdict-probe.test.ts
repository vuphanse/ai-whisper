import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));
const scriptPath = resolve(
	root,
	"scripts/manual/phase-7f-orchestrator-verdict-probe.sh",
);

function readScript(): string {
	return readFileSync(scriptPath, "utf8");
}

describe("phase 7f orchestrator verdict probe script", () => {
	it("prints usage including wait flags and escalate omission note", () => {
		const output = execFileSync("bash", [scriptPath, "--help"], {
			cwd: root,
			encoding: "utf8",
		});

		expect(output).toContain("Usage:");
		expect(output).toContain("--source");
		expect(output).toContain("--target");
		expect(output).toContain("--message");
		expect(output).toContain("--idle-threshold-ms");
		expect(output).toContain("--wait-for-orchestrator-ms");
		expect(output).toContain("--reset-runtime");
		expect(output).toContain("--no-build");
		// escalate omission is documented
		expect(output).toContain("escalate scenario is not exercised here");
		expect(output).toContain("relay-orchestrator.test.ts");
	});

	it("has no --scenario flag", () => {
		const script = readScript();
		expect(script).not.toContain("--scenario");
	});

	it("exports AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED=1 unconditionally", () => {
		const script = readScript();
		expect(script).toContain("export AI_WHISPER_RELAY_ORCHESTRATOR_ENABLED=1");
		expect(script).not.toContain("AI_WHISPER_RELAY_ORCHESTRATOR_MAX_ROUNDS=1");
	});

	it("defaults source=claude target=codex and requires them to differ", () => {
		const script = readScript();
		expect(script).toContain('SOURCE="claude"');
		expect(script).toContain('TARGET="codex"');
		expect(script).toContain("--source and --target must differ");
	});

	it("defaults message to short unambiguous task", () => {
		const script = readScript();
		expect(script).toContain('MESSAGE="reply with exactly the word: done"');
	});

	it("sets AI_WHISPER_IDLE_THRESHOLD_MS on target mount and disables it on source", () => {
		const script = readScript();
		expect(script).toMatch(
			/AI_WHISPER_IDLE_THRESHOLD_MS=\$IDLE_THRESHOLD_MS.*collab mount \$TARGET/,
		);
		expect(script).toMatch(
			/AI_WHISPER_IDLE_THRESHOLD_MS=999999.*collab mount \$SOURCE/,
		);
	});

	it("sends only the @@handoff from source, no Ctrl-C to target", () => {
		const script = readScript();
		const sendKeysLines = script
			.split("\n")
			.filter((line) => line.includes("tmux send-keys"));

		expect(sendKeysLines).toHaveLength(1);
		expect(sendKeysLines[0]).toContain("$SESSION_NAME:$SOURCE");
		expect(sendKeysLines[0]).toContain("@@$TARGET");

		const targetSendKeys = sendKeysLines.filter((line) =>
			line.includes("$SESSION_NAME:$TARGET"),
		);
		expect(targetSendKeys).toHaveLength(0);
	});

	it("normalizes newlines before grep to handle column-wrapped panel output", () => {
		const script = readScript();
		expect(script).toMatch(/tr -d '\\n' <"\$file" \| grep -Fq/);
	});

	it("waits for orchestrator poll and LLM evaluation after handback", () => {
		const script = readScript();
		expect(script).toContain("WAIT_FOR_ORCHESTRATOR_MS");
		expect(script).toContain("orchestrator poll and LLM evaluation");
		expect(script).toContain("monitor.after-orchestrator");
	});

	it("captures collab inspect after orchestrator wait", () => {
		const script = readScript();
		expect(script).toContain("collab inspect");
		expect(script).toContain("inspect.after-orchestrator.txt");
	});

	it("asserts Orchestrator: yes, turn owner flip, Chain status: done, Chain: done", () => {
		const script = readScript();
		expect(script).toContain("Orchestrator: yes");
		expect(script).toContain("Turn owner: $TARGET");
		expect(script).toContain("Chain status: done");
		expect(script).toContain("Chain: done");
		expect(script).toContain("LLM verdict");
	});

	it("produces a pass/fail verdict from artifacts", () => {
		const script = readScript();
		expect(script).toContain("PROBE_OK=1");
		expect(script).toContain("Probe verdict: PASS");
		expect(script).toContain("Probe verdict: FAIL");
	});

	it("cleans collab state before checking for stale broker", () => {
		const script = readScript();
		const stopIndex = script.indexOf(
			"node packages/cli/dist/bin/whisper.js collab stop",
		);
		const portCheckIndex = script.indexOf("lsof -n -P -iTCP:4311 -sTCP:LISTEN");
		expect(stopIndex).toBeGreaterThan(-1);
		expect(portCheckIndex).toBeGreaterThan(-1);
		expect(stopIndex).toBeLessThan(portCheckIndex);
	});

	it("enables mounted provider input logging and starts relay-monitor", () => {
		const script = readScript();
		expect(script).toContain("AI_WHISPER_DEBUG_INPUT_LOG");
		expect(script).toContain("collab relay-monitor");
		expect(script).toContain("collab mount");
	});

	it("documents what probe demonstrates in completion banner", () => {
		const script = readScript();
		expect(script).toContain("What this probe demonstrated (when PASS):");
		expect(script).toContain("Orchestrator is enabled");
		expect(script).toContain("LLM returned verdict=done");
		expect(script).toContain("chain resolved");
	});

	it("documents escalate omission in notes", () => {
		const script = readScript();
		expect(script).toContain("escalate scenario omitted");
		expect(script).toContain("captureStatus=ok");
		expect(script).toContain("Covered by unit tests");
	});
});
