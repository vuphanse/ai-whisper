import { createInterface } from "node:readline";
import { Command } from "commander";
import { runCollabAttach } from "./commands/collab/attach.js";
import { runCollabInspect } from "./commands/collab/inspect.js";
import { runCollabRebind } from "./commands/collab/rebind.js";
import { runCollabRecover } from "./commands/collab/recover.js";
import { runCollabReconnect } from "./commands/collab/reconnect.js";
import { runCollabStart } from "./commands/collab/start.js";
import { runCollabStatus } from "./commands/collab/status.js";
import { runCollabStop } from "./commands/collab/stop.js";
import { runCollabTell } from "./commands/collab/tell.js";
import { chooseLaunchMode, detectTmux } from "./runtime/launcher.js";

interface WorkspaceOpts {
	workspace: string;
}

interface StartOpts extends WorkspaceOpts {
	tmux: boolean;
	launch: boolean;
}

interface TellOpts extends WorkspaceOpts {
	target: string;
	action?: string;
	artifact?: string[];
	title?: string;
}

function collectArtifact(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

export function createCli(): Command {
	const cli = new Command().name("whisper").description("ai-whisper CLI");

	const collab = cli
		.command("collab")
		.description("Manage AI agent collaboration sessions");

	collab
		.command("start")
		.description("Start a new collaboration session")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--no-tmux", "Disable tmux even if available")
		.option("--no-launch", "Start broker only, do not launch agent terminals")
		.action(async (opts: StartOpts) => {
			const launchMode = chooseLaunchMode({
				tmuxAvailable: detectTmux(),
				forceNoTmux: !opts.tmux,
				forceNoLaunch: !opts.launch,
			});
			const result = await runCollabStart({
				workspaceRoot: opts.workspace,
				now: new Date().toISOString(),
				launchMode,
			});
			console.log(
				`Collab started: ${result.collabId} (launch: ${result.launchMode})`,
			);
		});

	collab
		.command("status")
		.description("Show current collaboration status")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (opts: WorkspaceOpts) => {
			const status = await runCollabStatus({ workspaceRoot: opts.workspace });
			if (!status.active) {
				console.log(status.message);
			} else {
				console.log(`Collab active: ${status.collabId}`);

				if (status.recovery.state === "recovery_required") {
					console.log("  Recovery required: run `whisper collab recover`");
				} else if (status.recovery.state === "recovered") {
					console.log("  Recovered (idle): run `whisper collab reconnect <codex|claude>`");
				}

				for (const [role, binding] of [["Codex", status.roles.codex], ["Claude", status.roles.claude]] as const) {
					const health = "healthState" in binding && binding.healthState ? ` (${binding.healthState})` : "";
					console.log(`  ${role}: ${binding.bindingState}${health}`);
				}

				console.log(
					`  Broker health: ${status.brokerHealth.ok ? "ok" : "degraded"}`,
				);
				if (status.activeThread) {
					console.log(`  Active thread: ${status.activeThread.title}`);
				}
			}
		});

	collab
		.command("tell")
		.description("Send an instruction to an agent")
		.requiredOption("--target <agent>", "Target agent: codex or claude")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--action <action>", "Explicit requested action")
		.option(
			"--artifact <path>",
			"Artifact file path. Repeat for multiple files.",
			collectArtifact,
			[],
		)
		.option("--title <title>", "Thread title")
		.argument("<instruction>", "The instruction to send")
		.action(async (instruction: string, opts: TellOpts) => {
			const tellInput: Parameters<typeof runCollabTell>[0] = {
				workspaceRoot: opts.workspace,
				target: opts.target as "codex" | "claude",
				instruction,
				artifactPaths: opts.artifact ?? [],
				now: new Date().toISOString(),
			};
			if (opts.action) {
				tellInput.explicitAction = opts.action as NonNullable<
					typeof tellInput.explicitAction
				>;
			}
			if (opts.title) {
				tellInput.threadTitle = opts.title;
			}
			const reply = await runCollabTell(tellInput);
			if (reply) {
				console.log(`[${reply.kind}] ${reply.content}`);
			} else {
				console.log("No work items to process.");
			}
		});

	collab
		.command("attach")
		.description("Attach or adopt an agent session into the collab")
		.argument("<agent>", "Target agent: codex or claude")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--adopt-current-tty", "Adopt the tty of the current shell after provider suspend")
		.option("--tty <path>", "Adopt an explicit local tty path")
		.action(async (target: "codex" | "claude", opts: WorkspaceOpts & { adoptCurrentTty?: boolean; tty?: string }) => {
			const targetMode = opts.adoptCurrentTty ? "adopt_current_tty" as const : opts.tty ? "explicit_tty" as const : "snippet_shell" as const;
			const result = await runCollabAttach({
				workspaceRoot: opts.workspace,
				target,
				now: new Date().toISOString(),
				targetMode,
				...(opts.tty ? { explicitTtyPath: opts.tty } : {}),
			});
			if (result.mode === "snippet") {
				console.log(result.snippet);
			} else {
				console.log(`Adopted ${target} tty ${result.ttyPath}. Resume the provider with \`fg\`.`);
			}
		});

	collab
		.command("rebind")
		.description("Replace an existing agent binding with a new attach claim")
		.argument("<agent>", "Target agent: codex or claude")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--replace", "Replace the existing binding without prompting")
		.option("--adopt-current-tty", "Adopt the tty of the current shell after provider suspend")
		.option("--tty <path>", "Adopt an explicit local tty path")
		.action(
			async (
				target: "codex" | "claude",
				opts: WorkspaceOpts & { replace?: boolean; adoptCurrentTty?: boolean; tty?: string },
			) => {
				const targetMode = opts.adoptCurrentTty ? "adopt_current_tty" as const : opts.tty ? "explicit_tty" as const : "snippet_shell" as const;
				const result = await runCollabRebind({
					workspaceRoot: opts.workspace,
					target,
					now: new Date().toISOString(),
					...(opts.replace !== undefined ? { replace: opts.replace } : {}),
					isInteractive: Boolean(process.stdin.isTTY),
					targetMode,
					...(opts.tty ? { explicitTtyPath: opts.tty } : {}),
					confirmReplace: async (message: string) => {
						const rl = createInterface({ input: process.stdin, output: process.stdout });
						return new Promise<boolean>((resolve) => {
							rl.question(message, (answer) => {
								rl.close();
								resolve(answer.trim().toLowerCase() === "y");
							});
						});
					},
				});
				if (result.mode === "snippet") {
					console.log(result.snippet);
				} else {
					console.log(`Adopted ${target} tty ${result.ttyPath}. Resume the provider with \`fg\`.`);
				}
			},
		);

	collab
		.command("recover")
		.description("Recover the current workspace collab after broker loss")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (opts: WorkspaceOpts) => {
			const result = await runCollabRecover({
				workspaceRoot: opts.workspace,
				now: new Date().toISOString(),
			});
			console.log(`Collab recovered: ${result.bindings.length} remembered role bindings restored`);
		});

	collab
		.command("reconnect")
		.description("Reconnect a remembered role after broker recovery")
		.argument("<agent>", "Target agent: codex or claude")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--adopt-current-tty", "Adopt the tty of the current shell after provider suspend")
		.option("--tty <path>", "Adopt an explicit local tty path")
		.action((target: string, opts: WorkspaceOpts & { adoptCurrentTty?: boolean; tty?: string }) => {
			const targetMode = opts.adoptCurrentTty ? "adopt_current_tty" as const : opts.tty ? "explicit_tty" as const : "snippet_shell" as const;
			const result = runCollabReconnect({
				workspaceRoot: opts.workspace,
				target: target as "codex" | "claude",
				now: new Date().toISOString(),
				targetMode,
				...(opts.tty ? { explicitTtyPath: opts.tty } : {}),
			});
			if (result.mode === "snippet") {
				console.log(result.snippet);
			} else {
				console.log(`Adopted ${target} tty ${result.ttyPath}. Resume the provider with \`fg\`.`);
			}
		});

	collab
		.command("inspect")
		.description("Inspect the active collab thread")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--watch", "Continuously redraw the active-thread operator view")
		.action(async (opts: WorkspaceOpts & { watch?: boolean }) => {
			const output = await runCollabInspect({
				workspaceRoot: opts.workspace,
				now: new Date().toISOString(),
				watch: Boolean(opts.watch),
			});
			if (output) {
				process.stdout.write(output);
			}
		});

	collab
		.command("stop")
		.description("Stop the active collaboration session")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action((opts: WorkspaceOpts) => {
			const result = runCollabStop({ workspaceRoot: opts.workspace });
			if (result.stopped) {
				console.log(`Collab stopped: ${result.collabId}`);
			} else {
				console.log(result.message);
			}
		});

	return cli;
}
