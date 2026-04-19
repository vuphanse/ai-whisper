import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import {
	fakeBrokerSpawn,
	healthyBrokerAssess,
} from "./helpers/fake-broker-spawn.ts";

describe("cli collab start port hijack guard", () => {
	it("aborts when port 4311 is held by an unrelated process", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-start-hijack-"),
		);

		const isPortFree = vi.fn(async (_port: number) => false);
		const findPortOwnerPid = vi.fn((_port: number) => 98765);

		await expect(
			runCollabStart({
				workspaceRoot,
				now: "2026-04-19T05:00:00.000Z",
				launchMode: "none",
				spawnBroker: fakeBrokerSpawn(),
				assessBroker: healthyBrokerAssess,
				isPortFree,
				findPortOwnerPid,
			}),
		).rejects.toThrow(/4311.*already.*(?:run|held|busy)/i);

		expect(isPortFree).toHaveBeenCalledWith(4311);
	});

	it("proceeds normally when port 4311 is free", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-start-free-port-"),
		);

		const isPortFree = vi.fn(async (_port: number) => true);

		const result = await runCollabStart({
			workspaceRoot,
			now: "2026-04-19T05:00:00.000Z",
			launchMode: "none",
			spawnBroker: fakeBrokerSpawn(),
			assessBroker: healthyBrokerAssess,
			isPortFree,
		});

		expect(result.collabId).toMatch(/^collab_/);
	});
});
