import { mkdirSync } from "node:fs";
import { basename } from "node:path";
import {
	applyMigrations,
	createBrokerRuntime,
	openDatabase,
	upsertSessionAttachment,
} from "@ai-whisper/broker";
import {
	assessBrokerDaemon,
	spawnBrokerDaemon,
} from "../../runtime/broker-daemon.js";
import {
	CollabResolverError,
	resolveCollab,
} from "../../runtime/collab-resolver.js";
import { resolveCurrentTty } from "../../runtime/current-tty.js";
import { createMountSessionRuntime } from "../../runtime/mount-session-main.js";
import { isPortFree } from "../../runtime/port-utils.js";
import {
	getSharedSqlitePath,
	getStateRoot,
} from "../../runtime/state-root.js";
import { waitForBrokerReady } from "../../runtime/wait-for-broker-ready.js";
import { runCollabStart } from "./start.js";

function defaultIsPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		// ESRCH = no such process (dead). EPERM = exists but not signalable (alive).
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

export function recordMountedSession(input: {
	cwd: string;
	agentType: "codex" | "claude";
	ttyPath: string;
	pid: number;
	collabIdOverride?: string;
}): void {
	const db = openDatabase(getSharedSqlitePath());
	try {
		const r = resolveCollab({
			db,
			cwd: input.cwd,
			...(input.collabIdOverride !== undefined
				? { collabIdOverride: input.collabIdOverride }
				: {}),
		});
		upsertSessionAttachment(db, {
			collabId: r.collabId,
			agentType: input.agentType,
			attachmentKind: "mounted",
			sessionId: null,
			providerId: null,
			launchMode: null,
			ttyPath: input.ttyPath,
			pid: input.pid,
			windowLabel: null,
			attachedAt: new Date().toISOString(),
		});
	} finally {
		db.close();
	}
}

export async function runCollabMount(input: {
	workspaceRoot: string;
	collabIdOverride?: string;
	target: "codex" | "claude";
	/**
	 * Args forwarded after `--` to the visible agent binary spawn
	 * (e.g. `mount codex -- --full-auto --model gpt-5`). Threaded to
	 * createInteractiveSessionForTarget only — the relay/companion provider
	 * side is unaffected. Defaults to []. No shell escaping; the CLI relies
	 * on commander 13's variadic positional to yield a clean string[].
	 */
	passthroughArgs?: string[];
	now: string;
	resolveCurrentTty?: () => string;
	createRuntime?: typeof createMountSessionRuntime;
	assessBroker?: typeof assessBrokerDaemon;
	/**
	 * Test seam: override the auto-create call. Defaults to runCollabStart.
	 * Used in tests to simulate a parallel mount winning the create race.
	 */
	runStartFn?: typeof runCollabStart;
	/**
	 * Test seam: override the pid liveness check used when deciding whether a
	 * "bound" binding has a live owner. Defaults to defaultIsPidAlive.
	 */
	isPidAlive?: (pid: number) => boolean;
}) {
	// Ensure the shared SQLite file exists with all tables before any
	// resolve attempt. Without this, the initial resolveCollab in a
	// brand-new workspace throws SqliteError("no such table: collab")
	// instead of the expected CollabResolverError(NoCollabFoundForCwd),
	// which would skip the auto-create branch below.
	mkdirSync(getStateRoot(), { recursive: true });
	{
		const db = openDatabase(getSharedSqlitePath());
		try {
			applyMigrations(db);
		} finally {
			db.close();
		}
	}

	const tryResolve = () => {
		const db = openDatabase(getSharedSqlitePath());
		try {
			return resolveCollab({
				db,
				cwd: input.workspaceRoot,
				...(input.collabIdOverride
					? { collabIdOverride: input.collabIdOverride }
					: {}),
				requireActive: true,
				requireDaemon: true,
			});
		} finally {
			db.close();
		}
	};

	const resolveOrCreate = async () => {
		try {
			return tryResolve();
		} catch (err) {
			// Auto-create a fresh collab when the workspace has none
			// (NoCollabFoundForCwd) OR when its only collab was already stopped
			// (CollabAlreadyStopped — e.g. after `whisper collab stop`; without
			// this the user could never re-mount in a workspace they'd stopped).
			// lookupByCwd prefers an active collab, so the new one wins on
			// re-resolve and the stopped row is harmlessly ignored.
			// NoLiveDaemonForCollab + WorkspaceUnreadable must still propagate:
			// the first is a recover scenario, the second a real fs error.
			if (
				!(
					err instanceof CollabResolverError &&
					(err.kind === "NoCollabFoundForCwd" ||
						err.kind === "CollabAlreadyStopped")
				)
			) {
				throw err;
			}
			// Don't auto-create when caller passed an explicit collab id.
			if (input.collabIdOverride !== undefined) {
				throw err;
			}
		}

		try {
			await (input.runStartFn ?? runCollabStart)({
				cwd: input.workspaceRoot,
				displayName: basename(input.workspaceRoot),
				launchMode: "none",
				now: () => new Date().toISOString(),
				isPortFreeOs: (port: number) => isPortFree(port),
				spawnBroker: ({ collabId, host, port, sqlitePath }) =>
					spawnBrokerDaemon(sqlitePath, host, port, collabId),
				waitForReady: ({ host, port, collabId, timeoutMs }) =>
					waitForBrokerReady({ host, port, collabId, timeoutMs }),
				signalProcess: (pid, signal) => {
					try {
						process.kill(pid, signal);
					} catch {
						// ignore
					}
				},
			});
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			if (!/active collab .* already exists/.test(msg)) throw err;
		}

		return tryResolve();
	};

	const resolved = await resolveOrCreate();

	if (resolved.recovery.state === "recovery_required") {
		throw new Error(
			"Broker is unavailable for the current collab. Run `whisper collab recover`.",
		);
	}
	if (resolved.recovery.state === "recovered") {
		throw new Error(
			"Collab has been recovered and still needs reconnect. Run `whisper collab reconnect <codex|claude>`.",
		);
	}

	// daemon is non-null because requireDaemon: true.
	const daemon = resolved.daemon as { host: string; port: number; pid: number };

	// Optional broker probe (callers in tests inject a mock).
	if (input.assessBroker) {
		const health = await input.assessBroker({
			host: daemon.host,
			port: daemon.port,
			pid: daemon.pid,
		});
		if (!health.ok) {
			throw new Error(
				"Broker is unavailable for the current collab. Run `whisper collab recover`.",
			);
		}
	}

	const ttyPath = (input.resolveCurrentTty ?? resolveCurrentTty)();
	const broker = createBrokerRuntime({
		sqlitePath: getSharedSqlitePath(),
		host: daemon.host,
		port: daemon.port,
		runWorkflowDriver: false,
		runDiagnosticsSweep: false,
		runDaemonHeartbeat: false,
		runBrokerDaemonSweep: false,
	});
	let brokerHandedOff = false;
	try {
		const current = broker.control
			.listSessionBindings(resolved.collabId)
			.find((binding) => binding.agentType === input.target);
		if (current?.bindingState === "bound") {
			const isAlive = input.isPidAlive ?? defaultIsPidAlive;
			const liveOwner = broker.control
				.listSessionAttachments(resolved.collabId)
				.some(
					(a) =>
						a.agentType === input.target &&
						a.pid !== null &&
						isAlive(a.pid),
				);
			if (liveOwner) {
				throw new Error(
					`${input.target === "codex" ? "Codex" : "Claude"} is already bound to a live session. Stop the existing mount tab and run \`whisper collab mount\` again.`,
				);
			}
			// No live owner — the previous mount session is gone but left the
			// binding "bound" (teardown marks degraded + deletes the attachment
			// but never unbinds; a crash skips teardown entirely). Reclaim it:
			// issueAttachClaim below overwrites bound → pending_attach → bound.
			console.error(
				`Reclaiming stale ${input.target} binding (previous mount session is gone).`,
			);
		}

		const claim = broker.control.issueAttachClaim({
			collabId: resolved.collabId,
			agentType: input.target,
			mode: "attach",
			targetMode: "mount_current_tty",
			targetTtyPath: ttyPath,
			now: input.now,
			expiresAt: new Date(Date.parse(input.now) + 5 * 60_000).toISOString(),
		});

		const runtime = (input.createRuntime ?? createMountSessionRuntime)({
			target: input.target,
			ttyPath,
			workspaceRoot: input.workspaceRoot,
			claimId: claim.claimId,
			secret: claim.secret,
			broker,
			passthroughArgs: input.passthroughArgs ?? [],
		});

		brokerHandedOff = true;
		await runtime.start();
	} finally {
		if (!brokerHandedOff) {
			await broker.stop();
		}
	}
}
