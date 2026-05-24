import { describe, expect, it, vi } from "vitest";
import {
	fetchLatestVersion,
	formatVersionReport,
	isNewerVersion,
	reportVersion,
} from "../packages/cli/src/runtime/version-check.ts";

describe("isNewerVersion", () => {
	it("compares semantic core versions numerically", () => {
		expect(isNewerVersion("0.1.5", "0.1.4")).toBe(true);
		expect(isNewerVersion("0.2.0", "0.1.9")).toBe(true);
		expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
		expect(isNewerVersion("0.1.4", "0.1.4")).toBe(false);
		expect(isNewerVersion("0.1.3", "0.1.4")).toBe(false);
		expect(isNewerVersion("0.9.9", "1.0.0")).toBe(false);
	});

	it("treats a stable release as newer than a prerelease of the same core", () => {
		expect(isNewerVersion("0.1.4", "0.1.4-beta.1")).toBe(true);
		expect(isNewerVersion("0.1.4-beta.1", "0.1.4")).toBe(false);
	});
});

describe("formatVersionReport", () => {
	it("appends an update notice when latest is newer", () => {
		const out = formatVersionReport("0.1.4", "0.1.5");
		expect(out).toContain("0.1.4");
		expect(out).toMatch(/newer version is available: 0\.1\.4 → 0\.1\.5/);
		expect(out).toContain("npm install -g ai-whisper@latest");
	});

	it("prints just the current version when up to date", () => {
		expect(formatVersionReport("0.1.5", "0.1.5")).toBe("0.1.5");
	});

	it("prints just the current version when latest is unknown (null)", () => {
		expect(formatVersionReport("0.1.5", null)).toBe("0.1.5");
	});

	it("prints just the current version when latest is older (local dev build)", () => {
		expect(formatVersionReport("0.2.0", "0.1.9")).toBe("0.2.0");
	});
});

describe("reportVersion", () => {
	it("writes the current version plus an update notice when a newer release exists", async () => {
		const lines: string[] = [];
		await reportVersion({
			current: "0.1.4",
			write: (s) => lines.push(s),
			fetchLatest: async () => "0.1.5",
		});
		expect(lines.join("\n")).toMatch(/0\.1\.4[\s\S]*newer version is available/);
	});

	it("skips the network check (and prints only the version) when disabled", async () => {
		const lines: string[] = [];
		const fetchLatest = vi.fn(async () => "0.9.9");
		await reportVersion({ current: "0.1.4", write: (s) => lines.push(s), fetchLatest, disabled: true });
		expect(lines).toEqual(["0.1.4"]);
		expect(fetchLatest).not.toHaveBeenCalled();
	});

	it("prints only the version when the latest lookup fails", async () => {
		const lines: string[] = [];
		await reportVersion({ current: "0.1.4", write: (s) => lines.push(s), fetchLatest: async () => null });
		expect(lines).toEqual(["0.1.4"]);
	});
});

describe("fetchLatestVersion", () => {
	it("returns the version from a registry 'latest' response", async () => {
		const fetchImpl = (async () =>
			({ ok: true, json: async () => ({ version: "0.1.7" }) })) as unknown as typeof fetch;
		expect(await fetchLatestVersion({ fetchImpl })).toBe("0.1.7");
	});

	it("returns null on a non-OK response", async () => {
		const fetchImpl = (async () => ({ ok: false, json: async () => ({}) })) as unknown as typeof fetch;
		expect(await fetchLatestVersion({ fetchImpl })).toBeNull();
	});

	it("returns null when the request throws (offline / abort)", async () => {
		const fetchImpl = (async () => {
			throw new Error("ENOTFOUND");
		}) as unknown as typeof fetch;
		expect(await fetchLatestVersion({ fetchImpl })).toBeNull();
	});
});
