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
};

describe("launcher real behavior", () => {
	describe("detectTmux", () => {
		it("returns a boolean indicating tmux availability", () => {
			const result = detectTmux();
			expect(typeof result).toBe("boolean");
		});
	});

	describe("mount command identity binding", () => {
		it("commands include broker endpoint, sqlite path, and collab id as env vars, and invoke mount", () => {
			const result = launchSessions({
				launchMode: "terminals",
				...baseLaunchInput,
				brokerSqlitePath:
					"/tmp/test-workspace/.ai-whisper/runtime/broker.sqlite",
				spawn: () => {},
			});

			expect(result.commands.codex).toContain("collab mount codex");
			expect(result.commands.claude).toContain("collab mount claude");
			expect(result.commands.relayMonitor).toContain("relay-monitor");
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
			// Mount resolves bindings via broker at runtime — no session id needed at launch.
			expect(result.commands.codex).not.toContain("AI_WHISPER_SESSION_ID=");
		});

		it("passes through additional AI_WHISPER environment variables to launched sessions", () => {
			const original = process.env.AI_WHISPER_DEBUG_INPUT_LOG;
			process.env.AI_WHISPER_DEBUG_INPUT_LOG = "/tmp/ai-whisper-input.log";

			try {
				const result = launchSessions({
					launchMode: "terminals",
					...baseLaunchInput,
					brokerSqlitePath:
						"/tmp/test-workspace/.ai-whisper/runtime/broker.sqlite",
					spawn: () => {},
				});

				expect(result.commands.codex).toContain(
					"AI_WHISPER_DEBUG_INPUT_LOG='/tmp/ai-whisper-input.log'",
				);
				expect(result.commands.claude).toContain(
					"AI_WHISPER_DEBUG_INPUT_LOG='/tmp/ai-whisper-input.log'",
				);
			} finally {
				if (original === undefined) {
					delete process.env.AI_WHISPER_DEBUG_INPUT_LOG;
				} else {
					process.env.AI_WHISPER_DEBUG_INPUT_LOG = original;
				}
			}
		});
	});

	describe("terminals mode", () => {
		it("spawns three terminal processes: relay-monitor + mount codex + mount claude", () => {
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
			expect(spawned).toHaveLength(3);
			expect(result.runtime.codexWindowLabel).toBe(
				`whisper-${baseLaunchInput.collabId}-codex`,
			);
			expect(result.runtime.claudeWindowLabel).toBe(
				`whisper-${baseLaunchInput.collabId}-claude`,
			);
			expect(result.runtime.relayMonitorWindowLabel).toBe(
				`whisper-${baseLaunchInput.collabId}-relay-monitor`,
			);
			// relay-monitor must start first so mount panes find the monitor on their first poll
			expect(spawned[0]).toMatch(/relay-monitor/);
			expect(spawned[1]).toMatch(/collab mount codex/);
			expect(spawned[2]).toMatch(/collab mount claude/);
			for (const cmd of spawned) {
				if (process.platform === "darwin") {
					expect(cmd).toMatch(/osascript/);
					expect(cmd).toMatch(/Terminal/);
				} else {
					expect(cmd).toMatch(/x-terminal-emulator|xterm/);
				}
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
			expect(execed).toHaveLength(4);
			// relay-monitor starts first as the initial pane so it registers
			// before the mount panes poll for the monitor connection.
			expect(execed[0]).toContain("tmux new-session");
			expect(execed[0]).toContain("relay-monitor");
			expect(execed[1]).toContain("tmux split-window");
			expect(execed[1]).toContain("collab mount codex");
			expect(execed[2]).toContain("tmux split-window");
			expect(execed[2]).toContain("collab mount claude");
			expect(execed[3]).toContain("tmux set-option");
			expect(execed[3]).toContain("mouse on");
		});

		it("can append a tmux attach command for interactive start flows", () => {
			const execed: string[] = [];

			const result = launchSessions({
				launchMode: "tmux",
				...baseLaunchInput,
				brokerSqlitePath:
					"/tmp/test-workspace/.ai-whisper/runtime/broker.sqlite",
				exec: (command) => {
					execed.push(command);
				},
				attachTmux: true,
			});

			expect(result.launched).toBe(true);
			expect(result.tmuxSession).toMatch(/whisper-/);
			expect(execed).toHaveLength(5);
			expect(execed[4]).toContain("tmux attach -t");
			expect(execed[4]).toContain(result.tmuxSession!);
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
