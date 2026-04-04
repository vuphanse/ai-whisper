import { spawn } from "node:child_process";
import {
	createProviderIdentity,
	type CompanionProvider,
	type InteractiveSessionController,
	type ProviderReply,
	type ProviderWorkContext,
	type ProviderWorkRequest,
} from "@ai-whisper/shared";
import type { ClaudeCommandConfig } from "./claude-command.js";
import { buildClaudeFileBackedBrokerPrompt, buildClaudePrompt } from "./claude-prompt.js";
import { parseClaudeOutput } from "./parse-claude-output.js";

export function createClaudeProvider(
	config: ClaudeCommandConfig,
): CompanionProvider {
	let interactiveSession: InteractiveSessionController | null = null;

	return {
		getIdentity() {
			return createProviderIdentity({
				providerId: "anthropic-claude-cli",
				toolFamily: "claude-code",
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
			interactiveSession = session;
		},
		handleWork(request: ProviderWorkRequest, context?: ProviderWorkContext): Promise<ProviderReply> {
			// When an artifact handle is provided, use the retained request.json as
			// the authoritative source of truth instead of rebuilding from inline fields.
			const prompt = context?.artifactHandle
				? buildClaudeFileBackedBrokerPrompt(context.artifactHandle.requestFilePath)
				: buildClaudePrompt(request);

			return new Promise((resolve) => {
				const child = spawn(config.executable, [...config.execArgs, prompt], {
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
							content: `Claude exited with code ${code}: ${stderr.trim()}`,
							transitionIntent: "failed",
						});
						return;
					}

					resolve(parseClaudeOutput(stdout));
				});
			});
		},
	};
}
