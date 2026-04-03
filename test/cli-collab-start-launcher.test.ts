import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runCollabStart } from "../packages/cli/src/commands/collab/start.ts";
import { fakeBrokerSpawn } from "./helpers/fake-broker-spawn.ts";

describe("cli collab start launcher integration", () => {
  it("returns the chosen launch mode in the result", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-start-launcher-"));

    const result = await runCollabStart({
      workspaceRoot,
      now: "2026-04-03T00:00:00.000Z",
      launchMode: "terminals",
      spawnBroker: fakeBrokerSpawn(),
      spawn: () => {},
    });

    expect(result).toMatchObject({
      collabId: expect.stringMatching(/^collab_/) as unknown,
      launchMode: "terminals",
    });
  });

  it("reports tmux as launch mode when specified", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "ai-whisper-start-tmux-"));

    const result = await runCollabStart({
      workspaceRoot,
      now: "2026-04-03T00:00:00.000Z",
      launchMode: "tmux",
      spawnBroker: fakeBrokerSpawn(),
      spawn: () => {},
    });

    expect(result).toMatchObject({
      launchMode: "tmux",
    });
  });
});
