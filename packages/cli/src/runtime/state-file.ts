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

const cliCollabStateV3Schema = z.object({
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

const adoptedSessionStateSchema = z.object({
	agentType: z.enum(["codex", "claude"]),
	ttyPath: z.string(),
	daemonPid: z.number().int().positive(),
});

const mountedSessionStateSchema = z.object({
	agentType: z.enum(["codex", "claude"]),
	ttyPath: z.string(),
	sessionPid: z.number().int().positive(),
});

const cliCollabStateV4Schema = cliCollabStateV3Schema.extend({
	version: z.literal(4),
	adoptedSessions: z
		.object({
			codex: adoptedSessionStateSchema.optional(),
			claude: adoptedSessionStateSchema.optional(),
		})
		.default({}),
});

export const cliCollabStateSchema = cliCollabStateV4Schema.extend({
	version: z.literal(5),
	adoptedSessions: z
		.object({
			codex: adoptedSessionStateSchema.optional(),
			claude: adoptedSessionStateSchema.optional(),
		})
		.default({}),
	mountedSessions: z
		.object({
			codex: mountedSessionStateSchema.optional(),
			claude: mountedSessionStateSchema.optional(),
		})
		.default({}),
});

export type CliCollabState = z.infer<typeof cliCollabStateSchema>;

function normalizeCliCollabState(raw: unknown): CliCollabState {
	const v5 = cliCollabStateSchema.safeParse(raw);
	if (v5.success) return v5.data;

	const v4 = cliCollabStateV4Schema.safeParse(raw);
	if (v4.success) {
		return {
			...v4.data,
			version: 5,
			mountedSessions: {},
		};
	}

	const v3 = cliCollabStateV3Schema.safeParse(raw);
	if (v3.success) {
		return {
			...v3.data,
			version: 5,
			adoptedSessions: {},
			mountedSessions: {},
		};
	}

	const v2 = cliCollabStateV2Schema.safeParse(raw);
	if (v2.success) {
		return {
			...v2.data,
			version: 5,
			recovery: {
				state: "normal",
				idleAfterRecovery: false,
				recoveredAt: null,
			},
			adoptedSessions: {},
			mountedSessions: {},
		};
	}

	const v1 = cliCollabStateV1Schema.parse(raw);
	return {
		version: 5,
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
		recovery: {
			state: "normal",
			idleAfterRecovery: false,
			recoveredAt: null,
		},
		adoptedSessions: {},
		mountedSessions: {},
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
