import { Command } from "commander";
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
		.action(async (opts: StartOpts) => {
			const launchMode = chooseLaunchMode({
				tmuxAvailable: detectTmux(),
				forceNoTmux: !opts.tmux,
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
				console.log(`  Codex session: ${status.codexSessionId}`);
				console.log(`  Claude session: ${status.claudeSessionId}`);
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
