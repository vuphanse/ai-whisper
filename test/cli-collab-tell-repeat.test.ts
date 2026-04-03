import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMockProvider } from "../packages/companion-core/src/index.ts";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { runCollabTell } from "../packages/cli/src/commands/collab/tell.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";

describe("cli collab tell repeat", () => {
  it("allows a second tell without crashing on companion re-registration", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-phase5-tell-repeat-"));
    const planPath = join(workspaceRoot, "plan.md");
    writeFileSync(planPath, "# Plan\n");

    await runCollabStart({
      workspaceRoot,
      now: "2026-04-03T00:00:00.000Z",
      launchMode: "terminals",
      spawnBroker: fakeBrokerSpawn(),
      spawn: () => {},
    });

    await runCollabTell({
      workspaceRoot,
      target: "codex",
      instruction: "review this plan",
      explicitAction: "review_plan",
      artifactPaths: [planPath],
      threadTitle: "Review plan",
      providerOverride: createMockProvider(),
      now: "2026-04-03T00:00:01.000Z",
    });

    // Second tell on the same collab should not crash
    await expect(
      runCollabTell({
        workspaceRoot,
        target: "codex",
        instruction: "implement the plan",
        explicitAction: "implement_plan",
        artifactPaths: [planPath],
        providerOverride: createMockProvider(),
        now: "2026-04-03T00:00:02.000Z",
      }),
    ).resolves.toMatchObject({
      kind: "answer",
    });
  });
});
