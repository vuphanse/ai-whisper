import { Command } from "commander";
import { openDatabase } from "@ai-whisper/broker";
import { runCollabMount } from "./commands/collab/mount.js";
import { runCollabInspect } from "./commands/collab/inspect.js";
import { runCollabRecover } from "./commands/collab/recover.js";
import { runCollabReconnect } from "./commands/collab/reconnect.js";
import { runCollabRelayMonitor } from "./commands/collab/relay-monitor.js";
import { runCollabStart } from "./commands/collab/start.js";
import { runCollabStatus } from "./commands/collab/status.js";
import { runCollabStop } from "./commands/collab/stop.js";
import { runCollabTell } from "./commands/collab/tell.js";
import {
	assessBrokerDaemon,
	spawnBrokerDaemon,
} from "./runtime/broker-daemon.js";
import {
	chooseLaunchMode,
	detectTmux,
	launchSessions,
} from "./runtime/launcher.js";
import { getStateFilePath } from "./runtime/paths.js";
import { isPortFree } from "./runtime/port-utils.js";
import { getSharedSqlitePath } from "./runtime/state-root.js";
import { writeCliCollabState } from "./runtime/state-file.js";
import { canonicalWorkspaceRoot } from "./runtime/workspace-id.js";
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

interface TellOpts {
	target: string;
	collab?: string;
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
			const workspaceRoot = canonicalWorkspaceRoot(opts.workspace);
			const startedAt = new Date().toISOString();
			const tmuxSessionName =
				launchMode === "tmux" ? undefined : undefined; // resolved below from collabId
			const r = await runCollabStart({
				cwd: opts.workspace,
				displayName: "phase5",
				launchMode,
				...(tmuxSessionName ? { tmuxSession: tmuxSessionName } : {}),
				now: () => new Date().toISOString(),
				isPortFreeOs: (port: number) => isPortFree(port),
				spawnBroker: ({ collabId, host, port, sqlitePath }) =>
					spawnBrokerDaemon(sqlitePath, host, port, collabId),
				waitForReady: async ({ host, port, collabId, timeoutMs }) => {
					const start = Date.now();
					const delayMs = 100;
					while (Date.now() - start < timeoutMs) {
						const db = openDatabase(getSharedSqlitePath());
						const row = db
							.prepare(
								"SELECT pid FROM broker_daemon WHERE collab_id = ?",
							)
							.get(collabId) as { pid: number | null } | undefined;
						db.close();
						const pid = row?.pid ?? 0;
						if (pid > 0) {
							const health = await assessBrokerDaemon({
								host,
								port,
								pid,
							});
							if (health.ok) return true;
						}
						await new Promise<void>((resolve) =>
							setTimeout(resolve, delayMs),
						);
					}
					return false;
				},
				signalProcess: (pid, signal) => {
					try {
						process.kill(pid, signal);
					} catch {
						// ignore
					}
				},
			});

			// LEGACY BRIDGE (kept until Task 24): writeCliCollabState
			const sharedSqlitePath = getSharedSqlitePath();
			const tmuxSession =
				launchMode === "tmux" ? `whisper-${r.collabId}` : undefined;
			writeCliCollabState(getStateFilePath(workspaceRoot), {
				version: 5,
				collabId: r.collabId,
				workspaceRoot,
				broker: {
					sqlitePath: sharedSqlitePath,
					host: r.host as "127.0.0.1",
					port: r.port,
					pid: r.pid,
				},
				launch: {
					mode: launchMode,
					...(tmuxSession ? { tmuxSession } : {}),
				},
				ownedSessions: {},
				startedAt,
				recovery: {
					state: "normal",
					idleAfterRecovery: false,
					recoveredAt: null,
				},
				adoptedSessions: {},
				mountedSessions: {},
			});

			// THEN launchSessions (unmigrated mount panes still read state.json).
			if (launchMode !== "none") {
				launchSessions({
					launchMode,
					...(attachTmux !== undefined ? { attachTmux } : {}),
					collabId: r.collabId,
					workspaceRoot,
					brokerSqlitePath: sharedSqlitePath,
					brokerHost: r.host,
					brokerPort: r.port,
				});
			}

			console.log(
				`Collab started: ${r.collabId} (launch: ${launchMode})`,
			);
			if (launchMode === "none") {
				console.log(
					"Collab started (no-launch mode).\nNext: run \"whisper collab relay-monitor\" in a separate terminal before mounting providers.",
				);
			}
			if (launchMode === "tmux" && !attachTmux) {
				const session = `whisper-${r.collabId}`;
				console.log(
					`\nNot attached (stdin/stdout is not a TTY). To view the tmux session, run:\n  tmux attach -t ${session}`,
				);
			}
		});

	collab
		.command("status")
		.description("Show current collaboration status")
		.option("--collab <id>", "Inspect a specific collab id (defaults to the active collab for cwd)")
		.action((opts: { collab?: string }) => {
			const output = runCollabStatus({
				cwd: process.cwd(),
				...(opts.collab ? { collabIdOverride: opts.collab } : {}),
			});
			console.log(output);
		});

	collab
		.command("tell")
		.description("Send an instruction to an agent")
		.requiredOption("--target <agent>", "Target agent: codex or claude")
		.option("--collab <id>", "Send to a specific collab id (defaults to the active collab for cwd)")
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
				cwd: process.cwd(),
				target: opts.target as "codex" | "claude",
				instruction,
				artifactPaths: opts.artifact ?? [],
				now: new Date().toISOString(),
			};
			if (opts.collab) {
				tellInput.collabIdOverride = opts.collab;
			}
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
		.option("--collab <id>", "Inspect a specific collab id (defaults to the active collab for cwd)")
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
				opts: {
					collab?: string;
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
					cwd: process.cwd(),
					...(opts.collab ? { collabIdOverride: opts.collab } : {}),
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
		.option("--collab <id>", "Monitor a specific collab id (defaults to the active collab for cwd)")
		.action(async (opts: { collab?: string }) => {
			await runCollabRelayMonitor({
				cwd: process.cwd(),
				...(opts.collab ? { collabIdOverride: opts.collab } : {}),
			});
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
