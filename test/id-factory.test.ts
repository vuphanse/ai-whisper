import { describe, expect, it } from "vitest";
import { createCliCollabId } from "../packages/cli/src/runtime/id-factory.ts";

describe("createCliCollabId", () => {
	it("keeps the timestamp digits as a sortable prefix", () => {
		const id = createCliCollabId("2026-05-16T12:34:56.789Z");
		expect(id).toMatch(/^collab_20260516123456789_[0-9a-f]{8}$/);
	});

	it("matches the collab id shape enforced by sessionBindingSchema", () => {
		const id = createCliCollabId("2026-05-16T12:34:56.789Z");
		expect(id).toMatch(/^collab_[a-z0-9_]+$/);
	});

	it("is unique across calls within the same millisecond (no PK collision)", () => {
		const now = "2026-05-16T12:34:56.789Z";
		const ids = new Set(
			Array.from({ length: 1000 }, () => createCliCollabId(now)),
		);
		expect(ids.size).toBe(1000);
	});
});
