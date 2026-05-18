import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("phase 7f autonomous idle handoff probe script", () => {
	it("prints usage information including idle-threshold-ms and wait flags", () => {
		const scriptPath = resolve(
			root,
			"scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh",
		);
		const output = execFileSync("bash", [scriptPath, "--help"], {
			cwd: root,
			encoding: "utf8",
		});

		expect(output).toContain("Usage:");
		expect(output).toContain("--source");
		expect(output).toContain("--target");
		expect(output).toContain("--message");
		expect(output).toContain("--idle-threshold-ms");
		expect(output).toContain("--wait-after-interrupt-ms");
		expect(output).toContain("--wait-after-handoff-ms");
		expect(output).toContain("--wait-for-provider-ms");
		expect(output).toContain("--reset-runtime");
		expect(output).toContain("--no-build");
	});

	it("sets AI_WHISPER_IDLE_THRESHOLD_MS on the target mount and disables it on the source", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh"),
			"utf8",
		);

		// Target command must carry the configurable threshold env var
		expect(script).toContain("AI_WHISPER_IDLE_THRESHOLD_MS=$IDLE_THRESHOLD_MS");
		expect(script).toMatch(
			/AI_WHISPER_IDLE_THRESHOLD_MS=\$IDLE_THRESHOLD_MS.*collab mount \$TARGET/,
		);
		// Source command must set a very large threshold so it never auto-accepts
		// the returned handoff — keeps the "Pending handoff" card visible for capture
		expect(script).toMatch(
			/AI_WHISPER_IDLE_THRESHOLD_MS=999999.*collab mount \$SOURCE/,
		);
	});

	it("sends only Ctrl-C (interrupt) and no 'a' or 'h' keypresses to the target window", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh"),
			"utf8",
		);

		const sendKeysLines = script
			.split("\n")
			.filter((line) => line.includes("tmux send-keys"));

		// Exactly two send-keys calls: Ctrl-C to target + @@handoff from source
		expect(sendKeysLines).toHaveLength(2);

		const targetSendKeys = sendKeysLines.filter((line) =>
			line.includes("$SESSION_NAME:$TARGET"),
		);
		const sourceSendKeys = sendKeysLines.filter((line) =>
			line.includes("$SESSION_NAME:$SOURCE"),
		);

		// Target receives only Ctrl-C to interrupt pre-existing task
		expect(targetSendKeys).toHaveLength(1);
		expect(targetSendKeys[0]).toContain("C-c");
		expect(targetSendKeys[0]).not.toMatch(/\ba\b/);
		expect(targetSendKeys[0]).not.toMatch(/\bh\b/);

		// Source sends the handoff message
		expect(sourceSendKeys).toHaveLength(1);
		expect(sourceSendKeys[0]).toContain("@@$TARGET");
	});

	it("runs collab inspect after auto-handback and captures the output", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh"),
			"utf8",
		);

		expect(script).toContain("collab inspect");
		expect(script).toContain("inspect.after-auto-handback.txt");
	});

	it("checks for Last capture: in inspect output to verify captureStatus was recorded", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh"),
			"utf8",
		);

		expect(script).toContain("Last capture:");
		expect(script).toContain("inspect reports captureStatus from autonomous handback");
	});

	it("asserts autonomous accept and handback with no keypress labels in check descriptions", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh"),
			"utf8",
		);

		expect(script).toContain("autonomous — no 'a' key sent");
		expect(script).toContain("autonomous — no 'h' key sent");
		expect(script).toContain("autonomous programmatic submit");
	});

	it("produces a pass/fail verdict from the captured autonomous-flow artifacts", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh"),
			"utf8",
		);

		expect(script).toContain("PROBE_OK=1");
		expect(script).toContain("Probe verdict: PASS");
		expect(script).toContain("Probe verdict: FAIL");
		expect(script).toContain("after-auto-accept");
		expect(script).toContain("after-auto-handback");
		expect(script).toContain("source receives returned handoff card");
	});

	it("documents what the probe demonstrates in the completion banner", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh"),
			"utf8",
		);

		expect(script).toContain("What this probe demonstrated (when PASS):");
		expect(script).toContain("without any 'a' keypress");
		expect(script).toContain("without any 'h' keypress");
		expect(script).toContain("captureStatus was recorded");
	});

	it("uses the shared-DB probe helper for cleanup and drops the fixed-port guard", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh"),
			"utf8",
		);

		expect(script).toContain(
			'source "$REPO_ROOT/scripts/manual/_probe-shared-db.sh"',
		);
		expect(script).toContain("probe_stop_if_active");
		expect(script).toContain("probe_reset_runtime");
		expect(script).not.toContain('rm -f "$STATE_FILE" "$SQLITE_FILE"');
		expect(script).not.toContain("lsof -n -P -iTCP:4311 -sTCP:LISTEN");
	});

	it("enables mounted provider input logging for both sides", () => {
		const script = readFileSync(
			resolve(root, "scripts/manual/phase-7f-autonomous-idle-handoff-probe.sh"),
			"utf8",
		);

		expect(script).toContain("AI_WHISPER_DEBUG_INPUT_LOG");
		expect(script).toContain("collab relay-monitor");
		expect(script).toContain("collab mount");
	});
});
