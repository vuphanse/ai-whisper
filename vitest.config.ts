import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ai-whisper/shared": resolve(__dirname, "packages/shared/src/index.ts"),
      "@ai-whisper/broker": resolve(__dirname, "packages/broker/src/index.ts"),
      "@ai-whisper/companion-core": resolve(__dirname, "packages/companion-core/src/index.ts"),
      "@ai-whisper/cli": resolve(__dirname, "packages/cli/src/index.ts"),
      "@ai-whisper/adapter-codex": resolve(__dirname, "packages/adapter-codex/src/index.ts"),
      "@ai-whisper/adapter-claude": resolve(__dirname, "packages/adapter-claude/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
