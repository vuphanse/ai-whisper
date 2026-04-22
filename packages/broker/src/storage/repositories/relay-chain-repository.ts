import type Database from "better-sqlite3";

export type RelayChainStatus = "active" | "done" | "escalated" | "abandoned";

export type RelayChainRecord = {
	chainId: string;
	collabId: string;
	status: RelayChainStatus;
	currentRound: number;
	maxRounds: number;
	terminalHandoffId: string | null;
	terminalReason: string | null;
	createdAt: string;
	updatedAt: string;
};

function rowToRecord(row: {
	chain_id: string;
	collab_id: string;
	status: string;
	current_round: number;
	max_rounds: number;
	terminal_handoff_id: string | null;
	terminal_reason: string | null;
	created_at: string;
	updated_at: string;
}): RelayChainRecord {
	return {
		chainId: row.chain_id,
		collabId: row.collab_id,
		status: row.status as RelayChainStatus,
		currentRound: row.current_round,
		maxRounds: row.max_rounds,
		terminalHandoffId: row.terminal_handoff_id,
		terminalReason: row.terminal_reason,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

export function insertRelayChain(
	db: Database.Database,
	input: { chainId: string; collabId: string; maxRounds: number; now: string },
): void {
	db.prepare(
		`INSERT INTO relay_chains
		 (chain_id, collab_id, status, current_round, max_rounds, terminal_handoff_id, terminal_reason, created_at, updated_at)
		 VALUES (?, ?, 'active', 1, ?, NULL, NULL, ?, ?)`,
	).run(input.chainId, input.collabId, input.maxRounds, input.now, input.now);
}

export function getRelayChain(
	db: Database.Database,
	chainId: string,
): RelayChainRecord | null {
	const row = db
		.prepare("SELECT * FROM relay_chains WHERE chain_id = ?")
		.get(chainId) as Parameters<typeof rowToRecord>[0] | undefined;
	return row ? rowToRecord(row) : null;
}

export function incrementChainRound(
	db: Database.Database,
	input: { chainId: string; now: string },
): void {
	db.prepare(
		`UPDATE relay_chains SET current_round = current_round + 1, updated_at = ? WHERE chain_id = ?`,
	).run(input.now, input.chainId);
}

export function setChainTerminal(
	db: Database.Database,
	input: {
		chainId: string;
		status: "done" | "escalated" | "abandoned";
		terminalHandoffId: string | null;
		terminalReason: string | null;
		now: string;
	},
): void {
	db.prepare(
		`UPDATE relay_chains
		   SET status = ?, terminal_handoff_id = ?, terminal_reason = ?, updated_at = ?
		 WHERE chain_id = ?`,
	).run(
		input.status,
		input.terminalHandoffId,
		input.terminalReason,
		input.now,
		input.chainId,
	);
}
