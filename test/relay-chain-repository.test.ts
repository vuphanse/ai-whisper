import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	insertRelayChain,
	getRelayChain,
	incrementChainRound,
	setChainTerminal,
} from "../packages/broker/src/storage/repositories/relay-chain-repository.ts";

function setup() {
	const broker = createBrokerRuntime({
		sqlitePath: ":memory:",
		host: "127.0.0.1",
		port: 4321,
	});
	const db = broker.db;
	db.prepare(
		`INSERT INTO collab (collab_id, workspace_root, display_name, status, created_at, updated_at)
		 VALUES ('c1','/tmp','c1','active','2026-04-21T00:00:00Z','2026-04-21T00:00:00Z')`,
	).run();
	return { db };
}

describe("relay-chain-repository", () => {
	it("insert + read round-trip", () => {
		const { db } = setup();
		insertRelayChain(db, {
			chainId: "relay_ch_1",
			collabId: "c1",
			maxRounds: 5,
			now: "2026-04-21T00:00:00Z",
		});
		const rec = getRelayChain(db, "relay_ch_1");
		expect(rec).toEqual({
			chainId: "relay_ch_1",
			collabId: "c1",
			status: "active",
			currentRound: 1,
			maxRounds: 5,
			terminalHandoffId: null,
			terminalReason: null,
			createdAt: "2026-04-21T00:00:00Z",
			updatedAt: "2026-04-21T00:00:00Z",
		});
	});

	it("increment + terminal transitions", () => {
		const { db } = setup();
		insertRelayChain(db, {
			chainId: "relay_ch_1",
			collabId: "c1",
			maxRounds: 5,
			now: "2026-04-21T00:00:00Z",
		});
		incrementChainRound(db, { chainId: "relay_ch_1", now: "2026-04-21T00:01:00Z" });
		expect(getRelayChain(db, "relay_ch_1")?.currentRound).toBe(2);
		setChainTerminal(db, {
			chainId: "relay_ch_1",
			status: "escalated",
			terminalHandoffId: "ho_bad",
			terminalReason: "max-rounds-reached (5/5)",
			now: "2026-04-21T00:02:00Z",
		});
		const terminal = getRelayChain(db, "relay_ch_1");
		expect(terminal?.status).toBe("escalated");
		expect(terminal?.terminalReason).toBe("max-rounds-reached (5/5)");
	});

	it("allows null terminalHandoffId for shutdown-driven abandonment", () => {
		const { db } = setup();
		insertRelayChain(db, {
			chainId: "relay_ch_1",
			collabId: "c1",
			maxRounds: 5,
			now: "2026-04-21T00:00:00Z",
		});
		setChainTerminal(db, {
			chainId: "relay_ch_1",
			status: "abandoned",
			terminalHandoffId: null,
			terminalReason: "broker-shutdown",
			now: "2026-04-21T00:02:00Z",
		});
		const terminal = getRelayChain(db, "relay_ch_1");
		expect(terminal?.status).toBe("abandoned");
		expect(terminal?.terminalHandoffId).toBeNull();
		expect(terminal?.terminalReason).toBe("broker-shutdown");
	});
});
