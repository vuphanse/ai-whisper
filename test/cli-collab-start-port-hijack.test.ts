import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startCollabForTest } from "./helpers/start-collab-for-test.ts";

describe("cli collab start port hijack guard", () => {
	it("aborts when the explicit port is held by an unrelated process", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-start-hijack-"),
		);

		const isPortFreeOs = vi.fn(async (_port: number) => false);

		await expect(
			startCollabForTest({
				workspaceRoot,
				now: "2026-04-19T05:00:00.000Z",
				launchMode: "none",
				explicitPort: 4311,
				isPortFreeOs,
			}),
		).rejects.toThrow(/4311.*in use by another process/i);

		expect(isPortFreeOs).toHaveBeenCalledWith(4311);
	});

	it("proceeds normally when the explicit port is free", async () => {
		const workspaceRoot = mkdtempSync(
			join(tmpdir(), "ai-whisper-start-free-port-"),
		);

		const isPortFreeOs = vi.fn(async (_port: number) => true);

		const result = await startCollabForTest({
			workspaceRoot,
			now: "2026-04-19T05:00:00.000Z",
			launchMode: "none",
			explicitPort: 4311,
			isPortFreeOs,
		});

		expect(result.collabId).toMatch(/^collab_/);
		expect(result.port).toBe(4311);
	});
});
