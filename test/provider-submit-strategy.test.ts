import { describe, expect, it, vi } from "vitest";
import { submitInjectedProviderInput } from "../packages/cli/src/runtime/provider-submit-strategy.ts";

describe("provider submit strategy", () => {
	it("types Codex input as a short keystream before submitting", async () => {
		const writes: string[] = [];
		const sleep = vi.fn(() => Promise.resolve());

		await submitInjectedProviderInput({
			target: "codex",
			text: "hi",
			writeUserInput: (text) => { writes.push(text); },
			sleep,
		});

		expect(writes).toEqual(["h", "i", "\r"]);
		expect(sleep).toHaveBeenCalledTimes(3);
		expect(sleep).toHaveBeenNthCalledWith(1, 5);
		expect(sleep).toHaveBeenNthCalledWith(2, 5);
		expect(sleep).toHaveBeenNthCalledWith(3, 100);
	});

	it("writes Claude input in one chunk before submitting", async () => {
		const writes: string[] = [];
		const sleep = vi.fn(() => Promise.resolve());

		await submitInjectedProviderInput({
			target: "claude",
			text: "tell me a joke",
			writeUserInput: (text) => { writes.push(text); },
			sleep,
		});

		expect(writes).toEqual(["tell me a joke", "\r"]);
		expect(sleep).toHaveBeenCalledTimes(1);
		expect(sleep).toHaveBeenCalledWith(75);
	});

	// Bug 2026-05-29 — Mode B: multi-line codex prompts never submit.
	// See docs/superpowers/bugs/2026-05-29-handback-capture-failures.md (Mode B).
	// When the typed payload contains any embedded LF, codex's TUI auto-enters
	// multi-line mode. In multi-line mode, a bare \r inserts another newline
	// instead of submitting — the prompt sits in the box forever, codex never
	// produces an assistant turn, and /copy returns clip_len=0. Surrounding
	// codex handoffs with identical prompt shape succeed when typed sequentially;
	// the failure is timing-sensitive (concurrent collabs slip the per-char
	// cadence into multi-line mode mid-stream). The fix path is bracketed paste
	// (\e[200~ … \e[201~) + an explicit submit sequence codex executes even in
	// multi-line mode (Esc-Enter \r or Ctrl+J "\n"), not bare \r.
	// TODO(2026-05-29): RED regression guard — skipped until a verified codex
	// submit sequence is established (its assumption is still unproven; see
	// docs/superpowers/bugs/2026-05-29-handback-capture-failures.md).
	describe.skip("Mode B repro — multi-line codex prompts", () => {
		it("delivers the full multi-line payload AND a submit byte sequence codex executes (not bare \\r absorbed by multi-line mode)", async () => {
			const writes: string[] = [];
			const sleep = vi.fn(() => Promise.resolve());
			const text = ["line 1: do the work", "line 2: verify it", "line 3: report back"].join("\n");

			await submitInjectedProviderInput({
				target: "codex",
				text,
				writeUserInput: (chunk) => { writes.push(chunk); },
				sleep,
			});

			const fullPayload = writes.join("");
			expect(fullPayload).toContain(text);

			// The terminating byte sequence must be one codex executes even when
			// embedded LFs in the prompt have flipped its input box into multi-line
			// mode. A bare "\r" is absorbed as a newline in that mode — the bug.
			const tail = writes[writes.length - 1];
			expect(tail).not.toBe("\r");
		});
	});
});
