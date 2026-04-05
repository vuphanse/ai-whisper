import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";

const sessionEntryV1Schema = z.object({
	sessionId: z.string(),
	providerId: z.string(),
	launchMode: z.enum(["tmux", "terminals"]),
	pid: z.number().int().positive().optional(),
	windowLabel: z.string().optional(),
});

const cliCollabStateV1Schema = z.object({
	version: z.literal(1),
	collabId: z.string(),
	workspaceRoot: z.string(),
	broker: z.object({
		sqlitePath: z.string(),
		host: z.literal("127.0.0.1"),
		port: z.number(),
		pid: z.number(),
	}),
	launch: z
		.object({
			tmuxSession: z.string().optional(),
		})
		.optional(),
	sessions: z.object({
		codex: sessionEntryV1Schema,
		claude: sessionEntryV1Schema,
	}),
	startedAt: z.string(),
});

const ownedLaunchSessionSchema = z.object({
	sessionId: z.string(),
	providerId: z.string(),
	launchMode: z.enum(["tmux", "terminals"]),
	pid: z.number().int().positive().optional(),
	windowLabel: z.string().optional(),
});

const cliCollabStateV2Schema = z.object({
	version: z.literal(2),
	collabId: z.string(),
	workspaceRoot: z.string(),
	broker: z.object({
		sqlitePath: z.string(),
		host: z.literal("127.0.0.1"),
		port: z.number(),
		pid: z.number(),
	}),
	launch: z
		.object({
			mode: z.enum(["tmux", "terminals", "none"]),
			tmuxSession: z.string().optional(),
		})
		.optional(),
	ownedSessions: z
		.object({
			codex: ownedLaunchSessionSchema.optional(),
			claude: ownedLaunchSessionSchema.optional(),
		})
		.default({}),
	startedAt: z.string(),
});

const recoveryStateSchema = z.object({
	state: z.enum(["normal", "recovery_required", "recovered"]),
	idleAfterRecovery: z.boolean(),
	recoveredAt: z.string().datetime({ offset: true }).nullable(),
});

export const cliCollabStateSchema = z.object({
	version: z.literal(3),
	collabId: z.string(),
	workspaceRoot: z.string(),
	broker: z.object({
		sqlitePath: z.string(),
		host: z.literal("127.0.0.1"),
		port: z.number(),
		pid: z.number(),
	}),
	launch: z
		.object({
			mode: z.enum(["tmux", "terminals", "none"]),
			tmuxSession: z.string().optional(),
		})
		.optional(),
	ownedSessions: z
		.object({
			codex: ownedLaunchSessionSchema.optional(),
			claude: ownedLaunchSessionSchema.optional(),
		})
		.default({}),
	startedAt: z.string(),
	recovery: recoveryStateSchema,
});

export type CliCollabState = z.infer<typeof cliCollabStateSchema>;

function normalizeCliCollabState(raw: unknown): CliCollabState {
	const v3 = cliCollabStateSchema.safeParse(raw);
	if (v3.success) return v3.data;

	const v2 = cliCollabStateV2Schema.safeParse(raw);
	if (v2.success) {
		return {
			...v2.data,
			version: 3,
			recovery: {
				state: "normal",
				idleAfterRecovery: false,
				recoveredAt: null,
			},
		};
	}

	const v1 = cliCollabStateV1Schema.parse(raw);
	const normalized = {
		version: 2 as const,
		collabId: v1.collabId,
		workspaceRoot: v1.workspaceRoot,
		broker: v1.broker,
		launch: {
			mode: (v1.launch?.tmuxSession ? "tmux" : "terminals") as "tmux" | "terminals" | "none",
			...(v1.launch?.tmuxSession ? { tmuxSession: v1.launch.tmuxSession } : {}),
		},
		ownedSessions: {
			codex: v1.sessions.codex,
			claude: v1.sessions.claude,
		},
		startedAt: v1.startedAt,
	};
	return {
		...normalized,
		version: 3,
		recovery: {
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		},
	};
}

export function writeCliCollabState(path: string, state: CliCollabState): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2));
}

export function readCliCollabState(path: string): CliCollabState | null {
	try {
		return normalizeCliCollabState(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return null;
	}
}

export function clearCliCollabState(path: string): void {
	rmSync(path, { force: true });
}

export function updateCliCollabState(
	path: string,
	update: (state: CliCollabState) => CliCollabState,
): void {
	const current = readCliCollabState(path);
	if (!current) {
		throw new Error(`No collab state found at ${path}`);
	}
	writeCliCollabState(path, update(current));
}
