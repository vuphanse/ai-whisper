import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/runtime/create-broker-runtime.ts";

describe("broker runtime", () => {
	it("reports health and status from the minimal broker app", async () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-runtime-"));
		const runtime = createBrokerRuntime({
			sqlitePath: join(dir, "broker.sqlite"),
			host: "127.0.0.1",
			port: 4311,
		});

		const health = await runtime.app.inject({
			method: "GET",
			url: "/health",
		});

		const status = await runtime.app.inject({
			method: "GET",
			url: "/status",
		});

		expect(health.statusCode).toBe(200);
		expect(health.json()).toEqual({
			ok: true,
		});

		expect(status.statusCode).toBe(200);
		expect(status.json()).toMatchObject({
			version: 1,
			status: "healthy",
			storage: {
				driver: "sqlite",
				migrated: true,
			},
		});

		await runtime.stop();
	});
});
