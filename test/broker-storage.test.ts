import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createBrokerRuntime } from "../packages/broker/src/index.ts";
import {
	applyMigrations,
	CURRENT_SCHEMA_VERSION,
} from "../packages/broker/src/storage/apply-migrations.ts";
import { getBrokerState } from "../packages/broker/src/storage/repositories/broker-state-repository.ts";
import { openDatabase } from "../packages/broker/src/storage/open-database.ts";

describe("broker storage bootstrap", () => {
	it("creates broker state and the phase 3 collaboration tables", () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-phase3-"));
		const db = openDatabase(join(dir, "broker.sqlite"));

		applyMigrations(db);

		expect(getBrokerState(db)).toEqual({
			schemaVersion: CURRENT_SCHEMA_VERSION,
			migrated: true,
		});

		const eventLogColumns = db
			.prepare("PRAGMA table_info(event_log)")
			.all() as Array<{ name: string }>;

		expect(eventLogColumns.map((column) => column.name)).toEqual([
			"id",
			"event_id",
			"schema_version",
			"event_type",
			"collab_id",
			"workspace_root",
			"payload_json",
			"created_at",
		]);
	});

	it("creates relay_capture_diagnostics with the expected columns and indexes", () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-cap-diag-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4501 });

		const columns = broker.db
			.prepare("PRAGMA table_info(relay_capture_diagnostics)")
			.all() as Array<{ name: string; notnull: number; dflt_value: string | null }>;
		const names = columns.map((c) => c.name).sort();

		expect(names).toEqual(
			[
				"aborted_by_race_guard",
				"capture_id",
				"capture_status",
				"chain_id",
				"clip_len",
				"clip_sample",
				"collab_id",
				"containment_score",
				"created_at",
				"handoff_id",
				"interference_detected",
				"jaccard_score",
				"target_provider",
				"turn_confidence",
				"turn_len",
				"turn_sample",
				"workflow_id",
			].sort(),
		);

		const indexes = broker.db
			.prepare("PRAGMA index_list(relay_capture_diagnostics)")
			.all() as Array<{ name: string }>;
		const indexNames = indexes.map((i) => i.name);
		expect(indexNames).toContain("idx_relay_capture_diagnostics_collab_created");
		expect(indexNames).toContain("idx_relay_capture_diagnostics_handoff");
		expect(indexNames).toContain("idx_relay_capture_diagnostics_chain_created");
		expect(indexNames).toContain("idx_relay_capture_diagnostics_status");

		void broker.stop();
	});

	it("creates relay_evaluator_diagnostics with the expected columns and indexes", () => {
		const dir = mkdtempSync(join(tmpdir(), "ai-whisper-eval-diag-"));
		const sqlitePath = join(dir, "broker.sqlite");
		const broker = createBrokerRuntime({ sqlitePath, host: "127.0.0.1", port: 4601 });

		const columns = broker.db
			.prepare("PRAGMA table_info(relay_evaluator_diagnostics)")
			.all() as Array<{ name: string }>;
		const names = columns.map((c) => c.name).sort();

		expect(names).toEqual(
			[
				"attempt_kind",
				"call_group_id",
				"chain_id",
				"collab_id",
				"confidence",
				"created_at",
				"error_message",
				"evaluator_branch",
				"evaluator_id",
				"evaluator_prompt_key",
				"follow_up_message_len",
				"handoff_id",
				"handoff_step",
				"input_tokens",
				"latency_ms",
				"outcome",
				"output_tokens",
				"phase_run_id",
				"prompt_sample",
				"provider",
				"reason",
				"response_sample",
				"verdict",
				"workflow_id",
			].sort(),
		);

		const indexes = broker.db
			.prepare("PRAGMA index_list(relay_evaluator_diagnostics)")
			.all() as Array<{ name: string }>;
		const indexNames = indexes.map((i) => i.name);
		expect(indexNames).toContain("idx_relay_evaluator_diagnostics_collab_created");
		expect(indexNames).toContain("idx_relay_evaluator_diagnostics_handoff");
		expect(indexNames).toContain("idx_relay_evaluator_diagnostics_chain_created");
		expect(indexNames).toContain("idx_relay_evaluator_diagnostics_workflow");
		expect(indexNames).toContain("idx_relay_evaluator_diagnostics_call_group");
		expect(indexNames).toContain("idx_relay_evaluator_diagnostics_outcome");

		void broker.stop();
	});
});
