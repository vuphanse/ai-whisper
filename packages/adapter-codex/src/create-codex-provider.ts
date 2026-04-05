import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	createProviderIdentity,
	type CompanionProvider,
	type InteractiveSessionController,
	type ProviderReply,
	type ProviderWorkContext,
	type ProviderWorkRequest,
} from "@ai-whisper/shared";
import type { CodexCommandConfig } from "./codex-command.js";
import { buildCodexFileBackedBrokerPrompt, buildCodexPrompt } from "./codex-prompt.js";
import { parseCodexOutput } from "./parse-codex-output.js";

export function createCodexProvider(
	config: CodexCommandConfig,
): CompanionProvider {
	return {
		getIdentity() {
			return createProviderIdentity({
				providerId: "openai-codex-cli",
				toolFamily: "codex",
				providerVersion: "1.0.0",
			});
		},
		getCapabilities() {
			return {
				supportsDirectPackets: true,
				supportsNormalization: true,
				supportsRelayInterception: true,
				supportsLocalBuffering: false,
				supportsLaunchHooks: true,
				extensions: {},
			};
		},
		getHealthState() {
			return "healthy";
		},
		attachInteractiveSession(session: InteractiveSessionController) {
			void session;
		},
		handleWork(request: ProviderWorkRequest, context?: ProviderWorkContext): Promise<ProviderReply> {
			// When an artifact handle is provided, use the retained request.json as
			// the authoritative source of truth instead of rebuilding from inline fields.
			const prompt = context?.artifactHandle
				? buildCodexFileBackedBrokerPrompt(context.artifactHandle.requestFilePath)
				: buildCodexPrompt(request);
			const outputLastMessagePath = context?.artifactHandle
				? join(context.artifactHandle.artifactDirPath, ".codex-last-message.json")
				: null;
			const spawnArgs = outputLastMessagePath
				? [...config.execArgs, "--output-last-message", outputLastMessagePath, prompt]
				: [...config.execArgs, prompt];

			return new Promise((resolve) => {
				const child = spawn(config.executable, spawnArgs, {
					stdio: ["ignore", "pipe", "pipe"],
				});

				let stdout = "";
				let stderr = "";
				let settled = false;

				child.stdout.on("data", (chunk) => {
					stdout += String(chunk);
				});

				child.stderr.on("data", (chunk) => {
					stderr += String(chunk);
				});

				child.on("error", (err) => {
					if (settled) return;
					settled = true;
					resolve({
						kind: "failure",
						content: `Failed to spawn ${config.executable}: ${err.message}`,
						transitionIntent: "failed",
					});
				});
				child.on("close", (code) => {
					if (settled) return;
					settled = true;
					if (code !== 0) {
						resolve({
							kind: "failure",
							content: `Codex exited with code ${code}: ${stderr.trim()}`,
							transitionIntent: "failed",
						});
						return;
					}

					if (outputLastMessagePath && existsSync(outputLastMessagePath)) {
						try {
							const fileReply = parseCodexOutput(readFileSync(outputLastMessagePath, "utf8"));
							if (fileReply.kind !== "failure") {
								resolve(fileReply);
								return;
							}
						} finally {
							try {
								rmSync(outputLastMessagePath, { force: true });
							} catch {
								// best-effort cleanup
							}
						}
					}

					const stdoutReply = parseCodexOutput(stdout);
					if (stdoutReply.kind !== "failure") {
						resolve(stdoutReply);
						return;
					}

					const stderrReply = parseCodexOutput(stderr);
					if (stderrReply.kind !== "failure") {
						resolve(stderrReply);
						return;
					}

					const combinedReply = parseCodexOutput(`${stdout}\n${stderr}`);
					resolve(combinedReply);
				});
			});
		},
	};
}
