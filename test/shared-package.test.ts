import { describe, expect, it } from "vitest";
import {
  createProviderIdentity,
  endpointHealthStates,
  sharedPackageName,
} from "../packages/shared/src/index.ts";

describe("@ai-whisper/shared", () => {
  it("exports provider identity helpers and endpoint health literals", () => {
    expect(sharedPackageName).toBe("@ai-whisper/shared");

    expect(
      createProviderIdentity({
        providerId: "openai-codex",
        toolFamily: "codex",
        providerVersion: "1.0.0",
      }),
    ).toEqual({
      providerId: "openai-codex",
      toolFamily: "codex",
      providerVersion: "1.0.0",
    });

    expect(endpointHealthStates).toContain("healthy");
    expect(endpointHealthStates).toContain("degraded");
    expect(endpointHealthStates).toContain("offline");
  });
});
