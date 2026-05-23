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
			{ agentType: "codex", pid: process.pid }, // alive
			{ agentType: "claude", pid: 2147483647 }, // dead (ESRCH on probe)
		]);
		expect(resolve("codex")).toBe(true);
		expect(resolve("claude")).toBe(false);
		// no attachment for an unknown agent → conservative false
		expect(resolve("ghost")).toBe(false);
	});

	it("absent pid on an attachment → false (conservative)", () => {
		const resolve = buildMountAliveByAgent([{ agentType: "codex", pid: null }]);
		expect(resolve("codex")).toBe(false);
	});
});
