import { describe, expect, it } from "vitest";
import {
	buildMountAliveByAgent,
	probeMountAlive,
} from "../packages/cli/src/runtime/dashboard.ts";

describe("probeMountAlive (host pid probe, Bug C)", () => {
	it("a live pid (this process) → true", () => {
		expect(probeMountAlive(process.pid)).toBe(true);
	});

	it("absent pid (null) → false (conservative)", () => {
		expect(probeMountAlive(null)).toBe(false);
	});

	it("a definitely-dead pid → false (ESRCH)", () => {
		// 0x7fffffff is far above any real pid; kill(pid, 0) throws ESRCH.
		const kill = ((pid: number, sig: number) => {
			void pid;
			void sig;
			const err = new Error("no such process") as NodeJS.ErrnoException;
			err.code = "ESRCH";
			throw err;
		}) as typeof process.kill;
		expect(probeMountAlive(2147483647, kill)).toBe(false);
	});

	it("EPERM (exists but not signalable) → true (alive)", () => {
		const kill = ((pid: number, sig: number) => {
			void pid;
			void sig;
			const err = new Error("operation not permitted") as NodeJS.ErrnoException;
			err.code = "EPERM";
			throw err;
		}) as typeof process.kill;
		expect(probeMountAlive(1234, kill)).toBe(true);
	});
});

describe("buildMountAliveByAgent (host wiring)", () => {
	it("maps a live pid → true and a dead pid → false per agent; absent agent → false", () => {
		const resolve = buildMountAliveByAgent([
			{ agentType: "codex", attachmentKind: "mounted", pid: process.pid }, // alive
			{ agentType: "claude", attachmentKind: "mounted", pid: 2147483647 }, // dead (ESRCH)
		]);
		expect(resolve("codex")).toBe(true);
		expect(resolve("claude")).toBe(false);
		// no attachment for an unknown agent → conservative false
		expect(resolve("ghost")).toBe(false);
	});

	it("absent pid on an attachment → false (conservative)", () => {
		const resolve = buildMountAliveByAgent([
			{ agentType: "codex", attachmentKind: "mounted", pid: null },
		]);
		expect(resolve("codex")).toBe(false);
	});

	// Criteria 6/7 — the MOUNTED attachment's pid is authoritative. A live older
	// owned/adopted pid must NOT mask a dead mounted worker (else false long-running).
	it("a live owned pid does NOT mask a dead mounted pid (mounted wins → false)", () => {
		const resolve = buildMountAliveByAgent([
			// ordered by attached_at ASC: owned first (alive), mounted later (dead)
			{ agentType: "codex", attachmentKind: "owned", pid: process.pid }, // alive
			{ agentType: "codex", attachmentKind: "mounted", pid: 2147483647 }, // dead
		]);
		expect(resolve("codex")).toBe(false); // mounted (dead) is authoritative
	});

	it("a dead owned pid does NOT force STUCK when the mounted pid is live (mounted wins → true)", () => {
		const resolve = buildMountAliveByAgent([
			{ agentType: "claude", attachmentKind: "adopted", pid: 2147483647 }, // dead
			{ agentType: "claude", attachmentKind: "mounted", pid: process.pid }, // alive
		]);
		expect(resolve("claude")).toBe(true);
	});

	it("no mounted attachment → false even if a live owned/adopted pid exists (spec lines 122-138)", () => {
		// Absent mounted pid must allow STUCK; a live non-mounted pid must NOT mask it.
		const resolve = buildMountAliveByAgent([
			{ agentType: "codex", attachmentKind: "owned", pid: process.pid }, // alive but NOT mounted
			{ agentType: "claude", attachmentKind: "adopted", pid: process.pid }, // alive but NOT mounted
		]);
		expect(resolve("codex")).toBe(false);
		expect(resolve("claude")).toBe(false);
	});

	it("mounted row with a null pid → false (conservative)", () => {
		const resolve = buildMountAliveByAgent([
			{ agentType: "codex", attachmentKind: "mounted", pid: null },
		]);
		expect(resolve("codex")).toBe(false);
	});
});
