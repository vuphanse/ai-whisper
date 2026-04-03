import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("README", () => {
	it("documents the phase-1 developer workflow", () => {
		const readme = readFileSync(resolve(root, "README.md"), "utf8");

		expect(readme).toContain("pnpm install");
		expect(readme).toContain("pnpm test");
		expect(readme).toContain("pnpm typecheck");
		expect(readme).toContain("pnpm lint");
		expect(readme).toContain("packages/shared");
		expect(readme).toContain("packages/broker");
		expect(readme).toContain("whisper collab start");
		expect(readme).toContain("whisper collab status");
		expect(readme).toContain("whisper collab tell");
		expect(readme).toContain("whisper collab stop");
		expect(readme).toContain("Phase 5");
	});
});
