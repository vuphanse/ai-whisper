import { Command } from "commander";
import { runCollabMount } from "./commands/collab/mount.js";
import { runCollabInspect } from "./commands/collab/inspect.js";
import { runCollabRecover } from "./commands/collab/recover.js";
import { runCollabReconnect } from "./commands/collab/reconnect.js";
import { runCollabRelayMonitor } from "./commands/collab/relay-monitor.js";
import { runCollabStart } from "./commands/collab/start.js";
import { runCollabStatus } from "./commands/collab/status.js";
import { runCollabStop } from "./commands/collab/stop.js";
import { runCollabTell } from "./commands/collab/tell.js";
import { chooseLaunchMode, detectTmux } from "./runtime/launcher.js";
import { runWorkflowStart } from "./commands/workflow/start.js";
import { runWorkflowList } from "./commands/workflow/list.js";
import { runWorkflowInspect } from "./commands/workflow/inspect.js";
import { runWorkflowResume } from "./commands/workflow/resume.js";
import { runWorkflowCancel } from "./commands/workflow/cancel.js";
import { runWorkflowTypes } from "./commands/workflow/types.js";
import { connectToWorkspaceBroker } from "./runtime/broker-connect.js";

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
			const attachTmux =
				launchMode === "tmux" &&
				Boolean(process.stdin.isTTY) &&
				Boolean(process.stdout.isTTY);
			const result = await runCollabStart({
				workspaceRoot: opts.workspace,
				now: new Date().toISOString(),
				launchMode,
				attachTmux,
			});
			console.log(
				`Collab started: ${result.collabId} (launch: ${result.launchMode})`,
			);
			if (launchMode === "tmux" && !attachTmux) {
				const session = `whisper-${result.collabId}`;
				console.log(
					`\nNot attached (stdin/stdout is not a TTY). To view the tmux session, run:\n  tmux attach -t ${session}`,
				);
			}
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
					const source = "bindingSource" in binding && binding.bindingSource ? ` [${binding.bindingSource}]` : "";
					console.log(`  ${role}: ${binding.bindingState}${health}${source}`);
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
		.description("Reconnect a remembered role after broker recovery (mount mode)")
		.argument("<agent>", "Target agent: codex or claude")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (target: string, opts: WorkspaceOpts) => {
			await runCollabReconnect({
				workspaceRoot: opts.workspace,
				target: target as "codex" | "claude",
				now: new Date().toISOString(),
			});
		});

	collab
		.command("mount")
		.description("Mount the current terminal as the managed session surface for a role")
		.argument("<agent>", "Target agent: codex or claude")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (target: "codex" | "claude", opts: WorkspaceOpts) => {
			await runCollabMount({
				workspaceRoot: opts.workspace,
				target,
				now: new Date().toISOString(),
			});
		});

	collab
		.command("inspect")
		.description("Inspect the active collab thread")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.option("--watch", "Continuously redraw the active-thread operator view")
		.option(
			"--captures [chainId]",
			"Show recent capture-diagnostics rows. Pass a chain id to filter, or 'all' for the full history.",
		)
		.option(
			"--verdicts [chainId]",
			"Show recent evaluator-diagnostics rows. Pass a chain id to filter, or 'all' for the full history. Mutually exclusive with --captures.",
		)
		.action(
			async (
				opts: WorkspaceOpts & {
					watch?: boolean;
					captures?: boolean | string;
					verdicts?: boolean | string;
				},
			) => {
				const capturesArg: true | string | undefined =
					opts.captures === undefined || opts.captures === false
						? undefined
						: opts.captures === true
							? true
							: opts.captures;
				const verdictsArg: true | string | undefined =
					opts.verdicts === undefined || opts.verdicts === false
						? undefined
						: opts.verdicts === true
							? true
							: opts.verdicts;

				const output = await runCollabInspect({
					workspaceRoot: opts.workspace,
					now: new Date().toISOString(),
					watch: Boolean(opts.watch),
					...(capturesArg !== undefined ? { captures: capturesArg } : {}),
					...(verdictsArg !== undefined ? { verdicts: verdictsArg } : {}),
				});
				if (output) {
					process.stdout.write(output);
				}
			},
		);

	collab
		.command("relay-monitor")
		.description("Run the relay monitor in the current terminal (renders the relay conversation stream)")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (opts: WorkspaceOpts) => {
			await runCollabRelayMonitor({ workspaceRoot: opts.workspace });
		});

	collab
		.command("stop")
		.description("Stop the active collaboration session")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (opts: WorkspaceOpts) => {
			const result = await runCollabStop({ workspaceRoot: opts.workspace });
			if (result.stopped) {
				console.log(`Collab stopped: ${result.collabId}`);
			} else {
				console.log(result.message);
			}
		});

	const workflow = cli
		.command("workflow")
		.description("Manage AI agent workflows");

	workflow
		.command("start")
		.description("Start a new workflow")
		.requiredOption("--type <type>", "Workflow type (e.g. spec-driven-development)")
		.requiredOption("--spec <path>", "Spec file path")
		.requiredOption("--implementer <agent>", "Implementer agent: claude or codex")
		.requiredOption("--reviewer <agent>", "Reviewer agent: claude or codex")
		.option("--name <name>", "Optional workflow display name")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(
			async (opts: WorkspaceOpts & {
				type: string;
				spec: string;
				implementer: "claude" | "codex";
				reviewer: "claude" | "codex";
				name?: string;
			}) => {
				const { broker, collabId } = await connectToWorkspaceBroker({ workspaceRoot: opts.workspace });
				try {
					const result = await runWorkflowStart({
						broker,
						collabId,
						workflowType: opts.type,
						specPath: opts.spec,
						implementer: opts.implementer,
						reviewer: opts.reviewer,
						...(opts.name ? { name: opts.name } : {}),
						now: new Date().toISOString(),
					});
					console.log(`Workflow started: ${result.workflowId}`);
				} finally {
					await broker.stop();
				}
			},
		);

	workflow
		.command("list")
		.description("List workflows for the active collab")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (opts: WorkspaceOpts) => {
			const { broker, collabId } = await connectToWorkspaceBroker({ workspaceRoot: opts.workspace });
			try {
				const list = runWorkflowList({ broker, collabId });
				if (list.length === 0) {
					console.log("No workflows.");
				} else {
					for (const wf of list) {
						console.log(`${wf.workflowId}  ${wf.workflowType}  ${wf.status}`);
					}
				}
			} finally {
				await broker.stop();
			}
		});

	workflow
		.command("inspect")
		.description("Inspect a workflow and its phase runs")
		.argument("<workflowId>", "Workflow ID")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (workflowId: string, opts: WorkspaceOpts) => {
			const { broker } = await connectToWorkspaceBroker({ workspaceRoot: opts.workspace });
			try {
				const result = await runWorkflowInspect({ broker, workflowId });
				console.log(JSON.stringify(result, null, 2));
			} finally {
				await broker.stop();
			}
		});

	workflow
		.command("resume")
		.description("Resume a halted workflow")
		.argument("<workflowId>", "Workflow ID")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (workflowId: string, opts: WorkspaceOpts) => {
			const { broker } = await connectToWorkspaceBroker({ workspaceRoot: opts.workspace });
			try {
				await runWorkflowResume({ broker, workflowId, now: new Date().toISOString() });
				console.log(`Workflow resumed: ${workflowId}`);
			} finally {
				await broker.stop();
			}
		});

	workflow
		.command("cancel")
		.description("Cancel a running or halted workflow")
		.argument("<workflowId>", "Workflow ID")
		.option("--workspace <path>", "Workspace root", process.cwd())
		.action(async (workflowId: string, opts: WorkspaceOpts) => {
			const { broker } = await connectToWorkspaceBroker({ workspaceRoot: opts.workspace });
			try {
				await runWorkflowCancel({ broker, workflowId, now: new Date().toISOString() });
				console.log(`Workflow canceled: ${workflowId}`);
			} finally {
				await broker.stop();
			}
		});

	workflow
		.command("types")
		.description("List registered workflow types")
		.action(async () => {
			const types = await runWorkflowTypes();
			for (const t of types) {
				console.log(t);
			}
		});

	return cli;
}
