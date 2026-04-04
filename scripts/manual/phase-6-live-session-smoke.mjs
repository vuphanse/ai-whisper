#!/usr/bin/env node
import fs from "node:fs";
import { join, resolve } from "node:path";
import { Writable } from "node:stream";
import { buildCodexInteractiveBrokerPrompt } from "../../packages/adapter-codex/dist/codex-live-session-prompt.js";
import { buildClaudeInteractiveBrokerPrompt } from "../../packages/adapter-claude/dist/claude-live-session-prompt.js";
import { createBrokerArtifactService } from "../../packages/cli/dist/runtime/broker-artifact-service.js";
import { createLiveSessionBrokerExecutor } from "../../packages/cli/dist/runtime/live-session-broker-executor.js";
import { getLiveSessionBrokerTempRoot } from "../../packages/cli/dist/runtime/paths.js";
import {
	createInteractiveSessionForTarget,
	createProviderForTarget,
	getInteractiveSessionExecArgsForTarget,
} from "../../packages/cli/dist/runtime/providers.js";
import {
	beginBrokerReply,
	endBrokerReply,
} from "../../packages/shared/dist/index.js";

const BRACKETED_PASTE_START = "\u001b[200~";
const BRACKETED_PASTE_END = "\u001b[201~";
const OUTPUT_TAIL_LIMIT = 600;

function usage() {
	process.stdout.write(`Usage: phase-6-live-session-smoke.mjs --provider <codex|claude> [options]

Options:
  --provider <codex|claude>
  --mode <broker|probe>
  --message <text>
  --attempt <name>
  --probe-payload <plain|framed-minimal|broker-current|file-read-sentinel>
  --workspace <path>
  --wait-ms <ms>
  --timeout-ms <ms>
  --probe-settle-ms <ms>
  --help
`);
}

function parseArgs(argv) {
	/** @type {{provider: "codex" | "claude" | null, mode: "broker" | "probe", message: string, attempt: string | null, probePayload: "plain" | "framed-minimal" | "broker-current" | "file-read-sentinel", workspace: string, waitMs: number, timeoutMs: number, probeSettleMs: number}} */
	const parsed = {
		provider: null,
		mode: "broker",
		message: "hello",
		attempt: null,
		probePayload: "plain",
		workspace: process.cwd(),
		waitMs: 1_500,
		timeoutMs: 15_000,
		probeSettleMs: 2_000,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--provider":
				parsed.provider = /** @type {"codex" | "claude"} */ (argv[++index] ?? null);
				break;
			case "--mode":
				parsed.mode =
					/** @type {"broker" | "probe"} */ (argv[++index] ?? parsed.mode);
				break;
			case "--message":
				parsed.message = argv[++index] ?? parsed.message;
				break;
			case "--attempt":
				parsed.attempt = argv[++index] ?? parsed.attempt;
				break;
			case "--probe-payload":
				parsed.probePayload =
					/** @type {"plain" | "framed-minimal" | "broker-current" | "file-read-sentinel"} */ (
						argv[++index] ?? parsed.probePayload
					);
				break;
			case "--workspace":
				parsed.workspace = resolve(argv[++index] ?? process.cwd());
				break;
			case "--wait-ms":
				parsed.waitMs = Number(argv[++index] ?? parsed.waitMs);
				break;
			case "--timeout-ms":
				parsed.timeoutMs = Number(argv[++index] ?? parsed.timeoutMs);
				break;
			case "--probe-settle-ms":
				parsed.probeSettleMs = Number(argv[++index] ?? parsed.probeSettleMs);
				break;
			case "--help":
			case "-h":
				usage();
				process.exit(0);
				break;
			default:
				throw new Error(`Unknown argument: ${arg}`);
		}
	}

	if (parsed.provider !== "codex" && parsed.provider !== "claude") {
		throw new Error("--provider must be codex or claude");
	}
	if (parsed.mode !== "broker" && parsed.mode !== "probe") {
		throw new Error("--mode must be broker or probe");
	}
	if (
		parsed.probePayload !== "plain" &&
		parsed.probePayload !== "framed-minimal" &&
		parsed.probePayload !== "broker-current" &&
		parsed.probePayload !== "file-read-sentinel"
	) {
		throw new Error("--probe-payload must be plain, framed-minimal, broker-current, or file-read-sentinel");
	}

	return parsed;
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

function createOutputCapture(input = { echo: true }) {
	const outputText = { value: "" };
	const tee = new Writable({
		write(chunk, _enc, callback) {
			const text = String(chunk);
			outputText.value += text;
			if (input.echo) {
				process.stdout.write(text);
			}
			callback();
		},
	});

	return { outputText, tee };
}

function escapeBytes(input) {
	return JSON.stringify(input).slice(1, -1);
}

function createProbeArtifact(input) {
	const tempRoot = getLiveSessionBrokerTempRoot();
	const artifactDirPath = join(
		tempRoot,
		`${new Date().toISOString().replace(/[:.]/g, "-")}-${input.workItemId}`,
	);
	const requestFilePath = join(artifactDirPath, "request.json");
	const statusFilePath = join(artifactDirPath, "status.json");
	fs.mkdirSync(artifactDirPath, { recursive: true });
	const tmpPath = `${requestFilePath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(input.requestData, null, 2));
	fs.renameSync(tmpPath, requestFilePath);
	return {
		workItemId: input.workItemId,
		artifactDirPath,
		requestFilePath,
		statusFilePath,
	};
}

function createProbePayload(options) {
	if (options.probePayload === "broker-current" || options.probePayload === "file-read-sentinel") {
		// DEBUG ONLY — these probe modes exercise live-session PTY/file-consumption
		// behavior and are not the supported production broker-delivery path.
		const workItemId = `work_probe_${options.provider}`;
		const requestData =
			options.probePayload === "broker-current"
				? {
						schemaVersion: 1,
						workItemId,
						collabId: "collab_probe",
						threadId: "thread_probe",
						requestedAction: "answer_question",
						instruction:
							"Reply with a minimal valid JSON object following the requested schema.",
				  }
				: {
						schemaVersion: 1,
						workItemId,
						collabId: "collab_probe",
						threadId: "thread_probe",
						requestedAction: "answer_question",
						instruction: "FILE_READ_SENTINEL_ONLY",
				  };
		const artifactHandle = createProbeArtifact({ workItemId, requestData });

		if (options.probePayload === "broker-current") {
			return {
				message:
					options.provider === "codex"
						? buildCodexInteractiveBrokerPrompt(artifactHandle.requestFilePath, workItemId)
						: buildClaudeInteractiveBrokerPrompt(artifactHandle.requestFilePath, workItemId),
				artifactHandle,
			};
		}

		return {
			message:
				options.provider === "codex"
					? [
							`Read the JSON file at ${artifactHandle.requestFilePath}.`,
							`Print exactly one line and nothing else: FILE_READ_OK:${workItemId}:answer_question`,
					  ].join("\n")
					: `Read the JSON file at ${artifactHandle.requestFilePath}. Print exactly one line and nothing else: FILE_READ_OK:${workItemId}:answer_question`,
			artifactHandle,
		};
	}

	if (options.probePayload === "framed-minimal") {
		const workItemId = "work_probe_frame";
		return {
			message: [
				`Print exactly this line: ${beginBrokerReply(workItemId)}`,
				'Print exactly this line: {"kind":"answer","content":"ok","transitionIntent":"completed"}',
				`Print exactly this line: ${endBrokerReply(workItemId)}`,
				"Print nothing else.",
			].join("\n"),
			artifactHandle: null,
		};
	}

	return {
		message: options.message,
		artifactHandle: null,
	};
}

function createProbeAttempts(provider, message) {
	const plain = message;
	const bracketed = `${BRACKETED_PASTE_START}${message}${BRACKETED_PASTE_END}`;
	const multiline = message.includes("\n");
	const linewiseLf = multiline
		? message.split("\n").flatMap((line) => [line, "\n"]).slice(0, -1)
		: [message, "\n"];
	const linewiseCr = multiline
		? message.split("\n").flatMap((line) => [line, "\r"]).slice(0, -1)
		: [message, "\r"];

	if (provider === "codex") {
		return [
			{ name: "plain+cr", writes: [plain, "\r"] },
			{ name: "plain+lf", writes: [plain, "\n"] },
			{ name: "plain+lf+delay", writes: [plain, { waitMs: 75 }, "\n"] },
			...(multiline
				? [
						{ name: "linewise+cr", writes: linewiseCr },
						{ name: "linewise+lf", writes: linewiseLf },
						{
							name: "linewise+lf+delay",
							writes: [...linewiseLf, { waitMs: 75 }, "\n"],
						},
					]
				: []),
			{ name: "bracketed+cr", writes: [bracketed, "\r"] },
			{ name: "bracketed+lf", writes: [bracketed, "\n"] },
			{ name: "bracketed+crlf", writes: [bracketed, "\r\n"] },
		];
	}

	return [
		{ name: "bracketed+cr", writes: [bracketed, "\r"] },
		{ name: "bracketed+lf", writes: [bracketed, "\n"] },
		{ name: "bracketed+crlf", writes: [bracketed, "\r\n"] },
		{ name: "plain+cr", writes: [plain, "\r"] },
		{ name: "plain+cr+delay", writes: [plain, { waitMs: 75 }, "\r"] },
		{ name: "plain+lf", writes: [plain, "\n"] },
	];
}

function createSmokeArtifactHandle(provider) {
	const workItemId = `work_smoke_${provider}`;
	const username = process.env["USER"] ?? process.env["USERNAME"] ?? "unknown";
	const artifactDirPath = join(
		os.tmpdir(),
		"ai-whisper",
		username,
		"live-session-broker",
		`${new Date().toISOString().replace(/[:.]/g, "-")}-${workItemId}`,
	);

	const requestFilePath = join(artifactDirPath, "request.json");
	const statusFilePath = join(artifactDirPath, "status.json");

	const requestData = {
		schemaVersion: 1,
		workItemId,
		collabId: "collab_smoke",
		threadId: "thread_smoke",
		requestedAction: "answer_question",
		instruction:
			"Reply with a minimal valid JSON object following the requested schema.",
	};

	fs.mkdirSync(artifactDirPath, { recursive: true });
	const tmpRequestPath = `${requestFilePath}.tmp`;
	fs.writeFileSync(tmpRequestPath, JSON.stringify(requestData, null, 2));
	fs.renameSync(tmpRequestPath, requestFilePath);

	// status.json not pre-written; populated by BrokerArtifactService when wired
	return { workItemId, artifactDirPath, requestFilePath, statusFilePath };
}

function readJsonIfExists(path) {
	if (!fs.existsSync(path)) {
		return null;
	}

	try {
		return JSON.parse(fs.readFileSync(path, "utf8"));
	} catch (error) {
		return {
			parseError: error instanceof Error ? error.message : String(error),
		};
	}
}

function summarizeRequestArtifact(requestJson) {
	if (!requestJson || typeof requestJson !== "object") {
		return requestJson;
	}

	return {
		schemaVersion: requestJson.schemaVersion,
		workItemId: requestJson.workItemId,
		collabId: requestJson.collabId,
		threadId: requestJson.threadId,
		requestedAction: requestJson.requestedAction,
	};
}

function readArtifactDiagnostics(artifactHandle) {
	if (!artifactHandle) {
		return null;
	}

	const requestJson = readJsonIfExists(artifactHandle.requestFilePath);
	const statusJson = readJsonIfExists(artifactHandle.statusFilePath);

	return {
		artifactDirPath: artifactHandle.artifactDirPath,
		requestFilePath: artifactHandle.requestFilePath,
		statusFilePath: artifactHandle.statusFilePath,
		requestExists: fs.existsSync(artifactHandle.requestFilePath),
		statusExists: fs.existsSync(artifactHandle.statusFilePath),
		request: summarizeRequestArtifact(requestJson),
		status: statusJson,
	};
}

function findLatestArtifactHandle(workItemId) {
	const tempRoot = getLiveSessionBrokerTempRoot();
	if (!fs.existsSync(tempRoot)) {
		return null;
	}

	const matchingDirs = fs
		.readdirSync(tempRoot)
		.filter((entry) => entry.endsWith(`-${workItemId}`))
		.sort();
	const latestDirName = matchingDirs.at(-1);
	if (!latestDirName) {
		return null;
	}

	const artifactDirPath = join(tempRoot, latestDirName);
	return {
		workItemId,
		artifactDirPath,
		requestFilePath: join(artifactDirPath, "request.json"),
		statusFilePath: join(artifactDirPath, "status.json"),
	};
}

function createProvider(options, session) {
	const provider = createProviderForTarget(options.provider);
	provider.attachInteractiveSession?.(session);
	return provider;
}

async function runBrokerMode(input) {
	const { options, outputText, session } = input;
	const request = {
		workItemId: `work_smoke_${options.provider}`,
		collabId: "collab_smoke",
		threadId: "thread_smoke",
		requestedAction: "answer_question",
		instruction:
			"Reply with a minimal valid JSON object following the requested schema.",
	};
	const provider = createProvider(options, session);
	const artifactService = createBrokerArtifactService();
	const executor = createLiveSessionBrokerExecutor({
		provider,
		artifactService,
		sessionId: `smoke_session_${options.provider}`,
	});

	let timeoutId;
	try {
		const reply = await Promise.race([
			executor(request),
			new Promise((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(`Timed out after ${options.timeoutMs}ms`));
				}, options.timeoutMs);
			}),
		]);

		return {
			provider: options.provider,
			workspace: options.workspace,
			waitMs: options.waitMs,
			timeoutMs: options.timeoutMs,
			execArgs: getInteractiveSessionExecArgsForTarget(options.provider),
			reply,
			tail: outputText.value.slice(-OUTPUT_TAIL_LIMIT),
			artifact: readArtifactDiagnostics(findLatestArtifactHandle(request.workItemId)),
		};
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
	}
}

async function runProbeMode(input) {
	const { options, stdin } = input;
	const attempts = [];
	const probePayload = createProbePayload(options);
	const probeMessage = probePayload.message;
	const configuredAttempts = createProbeAttempts(
		options.provider,
		probeMessage,
	);
	const attemptsToRun = options.attempt
		? configuredAttempts.filter((attempt) => attempt.name === options.attempt)
		: configuredAttempts;

	if (attemptsToRun.length === 0) {
		throw new Error(
			`Unknown probe attempt: ${options.attempt}. Valid attempts: ${configuredAttempts.map((attempt) => attempt.name).join(", ")}`,
		);
	}

	for (const attempt of attemptsToRun) {
		const { outputText, tee } = createOutputCapture({ echo: true });
		const session = createInteractiveSessionForTarget({
			target: options.provider,
			cwd: options.workspace,
			stdout: tee,
			replyTimeoutMs: options.timeoutMs,
		});
		let stdinListener;

		try {
			await session.start();
			stdinListener = (chunk) => session.writeUserInput(String(chunk));
			stdin.on("data", stdinListener);
			await sleep(options.waitMs);

			for (const write of attempt.writes) {
				if (typeof write === "object") {
					await sleep(write.waitMs);
					continue;
				}
				session.writeUserInput(write);
			}
			await sleep(options.probeSettleMs);

			attempts.push({
				name: attempt.name,
				writes: attempt.writes.map((write) =>
					typeof write === "object" ? `wait(${write.waitMs}ms)` : escapeBytes(write),
				),
				outputTail: outputText.value.slice(-OUTPUT_TAIL_LIMIT),
				outputLength: outputText.value.length,
				sawBrokerFrame:
					outputText.value.includes("AI_WHISPER_REPLY_BEGIN:") ||
					outputText.value.includes("AI_WHISPER_REPLY_END:"),
			});
		} finally {
			if (stdinListener) {
				stdin.off("data", stdinListener);
			}
			await session.stop();
		}
	}

	return {
		provider: options.provider,
		workspace: options.workspace,
		mode: options.mode,
		message: options.message,
		attempt: options.attempt,
		probePayload: options.probePayload,
		execArgs: getInteractiveSessionExecArgsForTarget(options.provider),
		artifact: readArtifactDiagnostics(probePayload.artifactHandle),
		attempts,
		tail: attempts.at(-1)?.outputTail ?? "",
	};
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const stdin = process.stdin;
	const previousRawMode = stdin.isRaw;
	const { outputText, tee } = createOutputCapture({
		echo: options.mode !== "probe",
	});
	const runtimeSession =
		options.mode === "broker"
			? createInteractiveSessionForTarget({
					target: options.provider,
					cwd: options.workspace,
					stdout: tee,
					replyTimeoutMs: options.timeoutMs,
			  })
			: null;

	let stdinListener;

	try {
		if (stdin.isTTY && typeof stdin.setRawMode === "function") {
			stdin.setRawMode(true);
		}
		stdin.resume();

		const result =
			options.mode === "probe"
				? await runProbeMode({ options, stdin })
				: await (async () => {
						await runtimeSession.start();
						stdinListener = (chunk) => runtimeSession.writeUserInput(String(chunk));
						stdin.on("data", stdinListener);
						await sleep(options.waitMs);
						return runBrokerMode({
							options,
							outputText,
							session: runtimeSession,
						});
				  })();

		process.stdout.write(
			`\n--- RESULT ---\n${JSON.stringify(result, null, 2)}\n`,
		);
	} catch (error) {
		process.stdout.write(
			`\n--- RESULT ---\n${JSON.stringify(
				{
					provider: options.provider,
					workspace: options.workspace,
					waitMs: options.waitMs,
					timeoutMs: options.timeoutMs,
					execArgs: getInteractiveSessionExecArgsForTarget(options.provider),
					error: error instanceof Error ? error.message : String(error),
					tail: outputText.value.slice(-OUTPUT_TAIL_LIMIT),
					artifact:
						options.mode === "broker"
							? readArtifactDiagnostics(
									findLatestArtifactHandle(`work_smoke_${options.provider}`),
							  )
							: undefined,
				},
				null,
				2,
			)}\n`,
		);
		process.exitCode = 1;
	} finally {
		if (stdinListener) {
			stdin.off("data", stdinListener);
		}
		if (stdin.isTTY && typeof stdin.setRawMode === "function") {
			stdin.setRawMode(Boolean(previousRawMode));
		}
		if (options.mode === "broker") {
			await runtimeSession.stop();
		}
	}
}

await main();
