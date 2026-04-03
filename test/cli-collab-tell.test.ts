import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../packages/companion-core/src/index.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";

describe("cli collab tell", () => {
  it("routes a work request and returns a provider-backed reply", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-phase5-tell-"));
    const planPath = join(workspaceRoot, "plan.md");
    writeFileSync(planPath, "# Plan\n");

    await runCollabStart({
      workspaceRoot,
      now: "2026-04-03T00:00:00.000Z",
      launchMode: "terminals",
    });

    await expect(
      runCollabTell({
        workspaceRoot,
        target: "codex",
        instruction: "review this plan",
        explicitAction: "review_plan",
        artifactPaths: [planPath],
        threadTitle: "Review plan",
        providerOverride: createMockProvider(),
        now: "2026-04-03T00:00:01.000Z",
      }),
    ).resolves.toMatchObject({
      kind: "review",
    });
  });
});
