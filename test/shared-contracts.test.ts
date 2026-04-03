import { describe, expect, it } from "vitest";
import {
	brokerSchemaVersion,
	brokerStatusSchema,
	createEventId,
	createWorkItemId,
	eventEnvelopeSchema,
	eventTypes,
	threadStates,
} from "../packages/shared/src/index.ts";

describe("shared contract primitives", () => {
	it("exports branded ID helpers, literal sets, and versioned schemas", () => {
		expect(brokerSchemaVersion).toBe(1);
		expect(createEventId("evt_0001")).toBe("evt_0001");
		expect(createWorkItemId("work_0001")).toBe("work_0001");
		expect(eventTypes).toContain("broker.started");
		expect(threadStates).toContain("in_progress");

		expect(
			eventEnvelopeSchema.parse({
				version: 1,
				eventId: "evt_0001",
				eventType: "broker.started",
				collabId: "collab_bootstrap",
				workspaceRoot: "/tmp/ai-whisper",
				timestamp: "2026-04-03T00:00:00.000Z",
				payload: {
					status: "healthy",
				},
			}),
		).toMatchObject({
			eventType: "broker.started",
		});

		expect(
			brokerStatusSchema.parse({
				version: 1,
				status: "healthy",
				storage: {
					driver: "sqlite",
					path: "/tmp/ai-whisper.sqlite",
					migrated: true,
				},
			}),
		).toMatchObject({
			status: "healthy",
		});
	});
});
