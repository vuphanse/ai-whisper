import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));

describe("phase 7e manual smoke script", () => {
	it("documents mount, automatic provider launch, and inline relay", () => {
		const script = readFileSync(resolve(root, "scripts/manual/phase-7e-mounted-session-smoke.sh"), "utf8");
		expect(script).toContain("node packages/cli/dist/bin/whisper.js collab mount");
		expect(script).toContain("node packages/cli/dist/bin/whisper.js collab status");
		expect(script).toContain("@@codex");
		expect(script).toContain("@@claude");
		expect(script).toContain("[mounted]");
	});
});

describe("README mount guidance", () => {
	it("documents mount as the inline relay path and attach as the legacy no-inline-relay path", () => {
		const readme = readFileSync(resolve(root, "README.md"), "utf8");
		expect(readme).toContain("whisper collab mount");
		expect(readme).toContain("attach --adopt-current-tty");
		expect(readme).toContain("does not support inline @@");
	});
});
