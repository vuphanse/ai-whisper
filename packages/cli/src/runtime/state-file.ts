import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import type { LaunchMode } from "./launcher.js";

const launchModeSchema: z.ZodType<LaunchMode> = z.enum(["tmux", "terminals"]);

const sessionEntrySchema = z.object({
	sessionId: z.string(),
	providerId: z.string(),
	launchMode: launchModeSchema,
	pid: z.number().int().positive().optional(),
	windowLabel: z.string().optional(),
});

export const cliCollabStateSchema = z.object({
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
		codex: sessionEntrySchema,
		claude: sessionEntrySchema,
	}),
	startedAt: z.string(),
});

export type CliCollabState = z.infer<typeof cliCollabStateSchema>;

export function writeCliCollabState(path: string, state: CliCollabState): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(state, null, 2));
}

export function readCliCollabState(path: string): CliCollabState | null {
	try {
		return cliCollabStateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
	} catch {
		return null;
	}
}

export function clearCliCollabState(path: string): void {
	rmSync(path, { force: true });
}
