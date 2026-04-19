import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabStop } from "../packages/cli/src/commands/collab/stop.ts";
import {
	fakeBrokerSpawn,
	healthyBrokerAssess,
} from "./helpers/fake-broker-spawn.ts";

describe("cli collab stop port fallback", () => {
	it("kills port owner when state pid is already dead but port still held", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-stop-port-fallback-"),
		);

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-19T05:00:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker: healthyBrokerAssess,
		});

		const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		// Simulate: state pid is dead from the start; port is held by a leaked
		// daemon that runs under a different pid (99999). Only killing 99999
		// releases the port.
		const stalePortOwner = 99999;
		let portHeld = true;
		const killProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
			killCalls.push({ pid, signal });
			if (pid === stalePortOwner) portHeld = false;
		});
		const pidAlive = vi.fn((_pid: number) => false);
		const isPortFree = vi.fn(async (_port: number) => !portHeld);
		const findPortOwnerPid = vi.fn((_port: number) => {
			return portHeld ? stalePortOwner : null;
		});

		const result = await runCollabStop({
			workspaceRoot,
			killProcess,
			pidAlive,
			isPortFree,
			findPortOwnerPid,
			sleep: async () => {},
		});

		expect(result.stopped).toBe(true);
		// lookup + kill of the port owner must have happened
		expect(findPortOwnerPid).toHaveBeenCalledWith(4311);
		expect(killCalls.some((c) => c.pid === 99999)).toBe(true);
	});

	it("escalates to SIGKILL when broker pid survives SIGTERM", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-stop-sigkill-"),
		);

		await runCollabStart({
			workspaceRoot,
			now: "2026-04-19T05:00:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker: healthyBrokerAssess,
		});

		const killed: Array<{ pid: number; signal: NodeJS.Signals }> = [];
		// SIGTERM does not kill; SIGKILL does.
		let alive = true;
		const killProcess = vi.fn((pid: number, signal: NodeJS.Signals) => {
			killed.push({ pid, signal });
			if (signal === "SIGKILL") alive = false;
		});
		const pidAlive = vi.fn((_pid: number) => alive);
		const isPortFree = vi.fn(async () => !alive);
		const findPortOwnerPid = vi.fn(() => null);

		await runCollabStop({
			workspaceRoot,
			killProcess,
			pidAlive,
			isPortFree,
			findPortOwnerPid,
			sleep: async () => {},
		});

		const signals = killed.map((k) => k.signal);
		expect(signals).toContain("SIGTERM");
		expect(signals).toContain("SIGKILL");
	});
});
