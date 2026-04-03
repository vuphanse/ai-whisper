import { spawn } from "node:child_process";
import {
  createProviderIdentity,
  type CompanionProvider,
  type ProviderWorkRequest,
} from "@ai-whisper/shared";
import type { ClaudeCommandConfig } from "./claude-command.js";
import { buildClaudePrompt } from "./claude-prompt.js";
import { parseClaudeOutput } from "./parse-claude-output.js";

export function createClaudeProvider(config: ClaudeCommandConfig): CompanionProvider {
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
        supportsRelayInterception: false,
        supportsLocalBuffering: false,
        supportsLaunchHooks: true,
        extensions: {},
      };
    },
    getHealthState() {
      return "healthy";
    },
    handleWork(request: ProviderWorkRequest) {
      const prompt = buildClaudePrompt(request);

      return new Promise((resolve, reject) => {
        const child = spawn(config.executable, [...config.execArgs, prompt], {
          stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk) => {
          stdout += String(chunk);
        });

        child.stderr.on("data", (chunk) => {
          stderr += String(chunk);
        });

        child.on("error", reject);
        child.on("close", (code) => {
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
