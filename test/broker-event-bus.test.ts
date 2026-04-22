import { describe, expect, it, vi } from "vitest";
import { createBrokerEventBus } from "../packages/broker/src/runtime/broker-event-bus.ts";

describe("BrokerEventBus", () => {
	it("delivers a typed event to subscribers", () => {
		const bus = createBrokerEventBus();
		const handler = vi.fn();
		bus.on("workflow.created", handler);
		bus.emit("workflow.created", { workflowId: "wf_1" });
		expect(handler).toHaveBeenCalledWith({ workflowId: "wf_1" });
	});

	it("unsubscribe stops future deliveries", () => {
		const bus = createBrokerEventBus();
		const handler = vi.fn();
		const off = bus.on("workflow.done", handler);
		off();
		bus.emit("workflow.done", { workflowId: "wf_1" });
		expect(handler).not.toHaveBeenCalled();
	});

	it("errors in one subscriber do not block others", () => {
		const bus = createBrokerEventBus();
		bus.on("chain.resolved", () => {
			throw new Error("boom");
		});
		const ok = vi.fn();
		bus.on("chain.resolved", ok);
		bus.emit("chain.resolved", { collabId: "c1", chainId: "ch_1" });
		expect(ok).toHaveBeenCalled();
	});
});
