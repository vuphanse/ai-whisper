#!/usr/bin/env node
import { Writable } from "node:stream";
import { resolve } from "node:path";
import { createCodexLiveSession } from "../../packages/adapter-codex/dist/create-codex-live-session.js";
import { createClaudeLiveSession } from "../../packages/adapter-claude/dist/create-claude-live-session.js";

function usage() {
	process.stdout.write(`Usage: phase-6-live-session-smoke.mjs --provider <codex|claude> [options]

Options:
  --provider <codex|claude>
  --workspace <path>
  --wait-ms <ms>
  --timeout-ms <ms>
  --help
`);
}

function parseArgs(argv) {
	/** @type {{provider: "codex" | "claude" | null, workspace: string, waitMs: number, timeoutMs: number}} */
	const parsed = {
		provider: null,
		workspace: process.cwd(),
		waitMs: 1_500,
		timeoutMs: 15_000,
	};

	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		switch (arg) {
			case "--provider":
				parsed.provider = /** @type {"codex" | "claude"} */ (argv[++index] ?? null);
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

	return parsed;
}

function sleep(ms) {
	return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	const output = [];
	const stdin = process.stdin;
	const previousRawMode = stdin.isRaw;
	const tee = new Writable({
		write(chunk, _enc, callback) {
			const text = String(chunk);
			output.push(text);
			process.stdout.write(text);
			callback();
		},
	});

	const request = {
		workItemId: `work_smoke_${options.provider}`,
		collabId: "collab_smoke",
		threadId: "thread_smoke",
		requestedAction: "answer_question",
		instruction:
			"Reply with a minimal valid JSON object following the requested schema.",
	};

	const session =
		options.provider === "codex"
			? createCodexLiveSession({
					config: {
						executable: process.env.AI_WHISPER_CODEX_CMD ?? "codex",
						execArgs: [],
					},
					cwd: options.workspace,
					stdout: tee,
			  })
			: createClaudeLiveSession({
					config: {
						executable: process.env.AI_WHISPER_CLAUDE_CMD ?? "claude",
						execArgs: [],
					},
					cwd: options.workspace,
					stdout: tee,
			  });

	let timeoutId;
	let stdinListener;

	try {
		if (stdin.isTTY && typeof stdin.setRawMode === "function") {
			stdin.setRawMode(true);
		}
		stdin.resume();

		await session.start();
		stdinListener = (chunk) => session.writeUserInput(String(chunk));
		stdin.on("data", stdinListener);
		await sleep(options.waitMs);

		const reply = await Promise.race([
			session.runBrokerWork(request),
			new Promise((_, reject) => {
				timeoutId = setTimeout(() => {
					reject(new Error(`Timed out after ${options.timeoutMs}ms`));
				}, options.timeoutMs);
			}),
		]);

		process.stdout.write(
			`\n--- RESULT ---\n${JSON.stringify(
				{
					provider: options.provider,
					workspace: options.workspace,
					reply,
					tail: output.join("").slice(-600),
				},
				null,
				2,
			)}\n`,
		);
	} catch (error) {
		process.stdout.write(
			`\n--- RESULT ---\n${JSON.stringify(
				{
					provider: options.provider,
					workspace: options.workspace,
					error: error instanceof Error ? error.message : String(error),
					tail: output.join("").slice(-600),
				},
				null,
				2,
			)}\n`,
		);
		process.exitCode = 1;
	} finally {
		if (timeoutId) {
			clearTimeout(timeoutId);
		}
		if (stdinListener) {
			stdin.off("data", stdinListener);
		}
		if (stdin.isTTY && typeof stdin.setRawMode === "function") {
			stdin.setRawMode(Boolean(previousRawMode));
		}
		await session.stop();
	}
}

await main();
