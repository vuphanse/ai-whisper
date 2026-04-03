import { resolve } from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@ai-whisper/shared": resolve(__dirname, "packages/shared/src/index.ts"),
      "@ai-whisper/broker": resolve(__dirname, "packages/broker/src/index.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"]
  }
});
