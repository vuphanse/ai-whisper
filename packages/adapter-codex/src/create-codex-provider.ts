import { spawn } from "node:child_process";
import {
  createProviderIdentity,
  type CompanionProvider,
  type ProviderWorkRequest,
} from "@ai-whisper/shared";
import type { CodexCommandConfig } from "./codex-command.js";
import { buildCodexPrompt } from "./codex-prompt.js";
import { parseCodexOutput } from "./parse-codex-output.js";

export function createCodexProvider(config: CodexCommandConfig): CompanionProvider {
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
      const prompt = buildCodexPrompt(request);

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
              content: `Codex exited with code ${code}: ${stderr.trim()}`,
              transitionIntent: "failed",
            });
            return;
          }

          resolve(parseCodexOutput(stdout));
        });
      });
    },
  };
}
