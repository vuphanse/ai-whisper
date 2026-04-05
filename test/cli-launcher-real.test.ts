import { describe, expect, it } from "vitest";
import {
	detectTmux,
	launchSessions,
} from "../packages/cli/src/runtime/launcher.ts";
import type { SpawnFn } from "../packages/cli/src/runtime/launcher.ts";

const baseLaunchInput = {
	collabId: "collab_20260403000000000",
	workspaceRoot: "/tmp/test-workspace",
	brokerHost: "127.0.0.1",
	brokerPort: 4311,
	codexSessionId: "session_codex_20260403000000000",
	claudeSessionId: "session_claude_20260403000000000",
};

describe("launcher real behavior", () => {
	describe("detectTmux", () => {
		it("returns a boolean indicating tmux availability", () => {
			const result = detectTmux();
			expect(typeof result).toBe("boolean");
		});
	});

	describe("agent command identity binding", () => {
		it("commands include broker endpoint, sqlite path, and session identity as env vars", () => {
			const result = launchSessions({
				launchMode: "terminals",
				...baseLaunchInput,
				brokerSqlitePath:
					"/tmp/test-workspace/.ai-whisper/runtime/broker.sqlite",
				spawn: () => {},
			});

			expect(result.commands.codex).toContain("companion-agent.js");
			expect(result.commands.codex).toContain(
				"AI_WHISPER_BROKER_HOST='127.0.0.1'",
			);
			expect(result.commands.codex).toContain("AI_WHISPER_BROKER_PORT='4311'");
			expect(result.commands.codex).toContain(
				"AI_WHISPER_BROKER_SQLITE='/tmp/test-workspace/.ai-whisper/runtime/broker.sqlite'",
			);
			expect(result.commands.codex).toContain(
				"AI_WHISPER_COLLAB_ID='collab_20260403000000000'",
			);
			expect(result.commands.codex).toContain(
				"AI_WHISPER_SESSION_ID='session_codex_20260403000000000'",
			);

			expect(result.commands.claude).toContain(
				"AI_WHISPER_SESSION_ID='session_claude_20260403000000000'",
			);
		});
	});

	describe("terminals mode", () => {
		it("spawns two terminal processes via osascript on darwin", () => {
			const spawned: string[] = [];
			const fakeSpawn: SpawnFn = (command) => {
				spawned.push(command);
			};

			const result = launchSessions({
				launchMode: "terminals",
				...baseLaunchInput,
				brokerSqlitePath:
					"/tmp/test-workspace/.ai-whisper/runtime/broker.sqlite",
				spawn: fakeSpawn,
			});

			expect(result.launched).toBe(true);
			expect(result.launchMode).toBe("terminals");
			expect(spawned).toHaveLength(2);
			expect(result.runtime.codexWindowLabel).toBe("whisper-codex");
			expect(result.runtime.claudeWindowLabel).toBe("whisper-claude");
			for (const cmd of spawned) {
				if (process.platform === "darwin") {
					expect(cmd).toMatch(/osascript/);
					expect(cmd).toMatch(/Terminal/);
				} else {
					expect(cmd).toMatch(/x-terminal-emulator|xterm/);
				}
				expect(cmd).toMatch(/companion-agent\.js/);
			}
		});
	});

	describe("tmux mode", () => {
		it("executes tmux setup commands synchronously instead of detached spawn", () => {
			const execed: string[] = [];
			const fakeSpawn: SpawnFn = () => {
				throw new Error("tmux startup must not use detached spawn");
			};

			const result = launchSessions({
				launchMode: "tmux",
				...baseLaunchInput,
				brokerSqlitePath:
					"/tmp/test-workspace/.ai-whisper/runtime/broker.sqlite",
				spawn: fakeSpawn,
				exec: (command) => {
					execed.push(command);
				},
			});

			expect(result.launched).toBe(true);
			expect(result.launchMode).toBe("tmux");
			expect(execed).toHaveLength(3);
			expect(execed[0]).toContain("tmux new-session");
			expect(execed[1]).toContain("tmux split-window");
			expect(execed[1]).toContain(":0");
			expect(execed[1]).not.toContain(":codex");
			expect(execed[2]).toContain("tmux set-option");
			expect(execed[2]).toContain("mouse on");
		});

		it("returns tmux session name and executes tmux commands", () => {
			const execed: string[] = [];
			const fakeExec = (command: string) => {
				execed.push(command);
			};

			const result = launchSessions({
				launchMode: "tmux",
				...baseLaunchInput,
				brokerSqlitePath:
					"/tmp/test-workspace/.ai-whisper/runtime/broker.sqlite",
				exec: fakeExec,
			});

			expect(result.launched).toBe(true);
			expect(result.launchMode).toBe("tmux");
			expect(result.tmuxSession).toMatch(/whisper-/);
			expect(execed.some((c) => c.includes("tmux new-session"))).toBe(true);
			expect(execed.some((c) => c.includes("tmux split-window"))).toBe(true);
			expect(execed.some((c) => c.includes("tmux set-option"))).toBe(true);
		});
	});
});
