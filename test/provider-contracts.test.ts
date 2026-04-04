import { describe, expect, it } from "vitest";
import {
	companionHeartbeatSchema,
	companionRegistrationSchema,
	createProviderIdentity,
	mockProviderReplySchema,
	providerCapabilitiesSchema,
	type BrokerArtifactHandle,
} from "../packages/shared/src/index.ts";
import {
	buildCodexFileBackedBrokerPrompt,
	createCodexLiveSession,
	createCodexProvider,
} from "../packages/adapter-codex/src/index.ts";
import {
	buildClaudeFileBackedBrokerPrompt,
	createClaudeLiveSession,
	createClaudeProvider,
} from "../packages/adapter-claude/src/index.ts";
import { createFakePty } from "./helpers/fake-pty.ts";

const stubHandle: BrokerArtifactHandle = {
	workItemId: "stub",
	artifactDirPath: "/tmp/artifacts/stub",
	requestFilePath: "/tmp/artifacts/stub/request.json",
	statusFilePath: "/tmp/artifacts/stub/status.json",
};

describe("provider and companion contracts", () => {
	it("validates provider identity, capabilities, and companion registration payloads", () => {
		const provider = createProviderIdentity({
			providerId: "mock-provider",
			toolFamily: "mock-agent",
			providerVersion: "1.0.0",
		});

		expect(provider.providerId).toBe("mock-provider");

		expect(
			providerCapabilitiesSchema.parse({
				supportsDirectPackets: true,
				supportsNormalization: false,
				supportsRelayInterception: false,
				supportsLocalBuffering: false,
				supportsLaunchHooks: false,
				extensions: {},
			}).supportsDirectPackets,
		).toBe(true);

		expect(
			companionRegistrationSchema.parse({
				version: 1,
				collabId: "collab_phase4",
				sessionId: "session_codex_1",
				provider,
				capabilities: {
					supportsDirectPackets: true,
					supportsNormalization: false,
					supportsRelayInterception: false,
					supportsLocalBuffering: false,
					supportsLaunchHooks: false,
					extensions: {},
				},
				registeredAt: "2026-04-03T00:00:00.000Z",
			}).sessionId,
		).toBe("session_codex_1");

		expect(
			companionHeartbeatSchema.parse({
				version: 1,
				collabId: "collab_phase4",
				sessionId: "session_codex_1",
				healthState: "healthy",
				sentAt: "2026-04-03T00:00:01.000Z",
			}).healthState,
		).toBe("healthy");

		expect(
			mockProviderReplySchema.parse({
				kind: "review",
				content: "Needs explicit retry handling.",
				transitionIntent: "awaiting_user",
			}).kind,
		).toBe("review");
	});

	it("builds real provider adapters with distinct identities", () => {
		expect(
			createCodexProvider({
				executable: "codex",
				execArgs: ["exec"],
			}).getIdentity().providerId,
		).toBe("openai-codex-cli");

		expect(
			createClaudeProvider({
				executable: "claude",
				execArgs: ["-p"],
			}).getIdentity().providerId,
		).toBe("anthropic-claude-cli");
	});

	it("providers support relay interception capability", () => {
		expect(
			createCodexProvider({ executable: "codex", execArgs: ["exec"] })
				.getCapabilities().supportsRelayInterception,
		).toBe(true);

		expect(
			createClaudeProvider({ executable: "claude", execArgs: ["-p"] })
				.getCapabilities().supportsRelayInterception,
		).toBe(true);
	});

	it("providers expose attachInteractiveSession", () => {
		expect(
			typeof createCodexProvider({ executable: "codex", execArgs: ["exec"] })
				.attachInteractiveSession,
		).toBe("function");

		expect(
			typeof createClaudeProvider({ executable: "claude", execArgs: ["-p"] })
				.attachInteractiveSession,
		).toBe("function");
	});

	it("live session factories are exported", () => {
		expect(typeof createCodexLiveSession).toBe("function");
		expect(typeof createClaudeLiveSession).toBe("function");
	});

	it("ProviderWorkContext only carries artifactHandle — onAttemptStart is not part of the contract", () => {
		// The ProviderWorkContext type must be structurally { artifactHandle?: BrokerArtifactHandle }.
		// onAttemptStart was a PTY retry-reporting hook and is now retired.
		// This test verifies the shape at the type level by constructing valid contexts.
		const noContext: import("../packages/shared/src/index.ts").ProviderWorkContext = {};
		const withHandle: import("../packages/shared/src/index.ts").ProviderWorkContext = {
			artifactHandle: stubHandle,
		};
		// Type-level assertion: both are assignable, neither has onAttemptStart.
		expect(Object.keys(noContext)).toEqual([]);
		expect(Object.keys(withHandle)).toEqual(["artifactHandle"]);
	});

	it("live sessions satisfy InteractiveSessionController as relay-UX controllers", () => {
		const fakePty = createFakePty();
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;

		// Both live session factories must return objects satisfying InteractiveSessionController.
		// The interface covers only relay UX methods: start, stop, writeUserInput, sendLocalMessage.
		// Broker work execution is no longer part of the session contract.
		const codexSession: import("../packages/shared/src/index.ts").InteractiveSessionController =
			createCodexLiveSession({
				config: { executable: "codex", execArgs: [] },
				cwd: "/tmp",
				stdout,
				createPty() {
					return fakePty;
				},
			});

		const claudeSession: import("../packages/shared/src/index.ts").InteractiveSessionController =
			createClaudeLiveSession({
				config: { executable: "claude", execArgs: ["-p"] },
				cwd: "/tmp",
				stdout,
				createPty() {
					return fakePty;
				},
			});

		expect(typeof codexSession.start).toBe("function");
		expect(typeof codexSession.stop).toBe("function");
		expect(typeof codexSession.writeUserInput).toBe("function");
		expect(typeof codexSession.sendLocalMessage).toBe("function");

		expect(typeof claudeSession.start).toBe("function");
		expect(typeof claudeSession.stop).toBe("function");
		expect(typeof claudeSession.writeUserInput).toBe("function");
		expect(typeof claudeSession.sendLocalMessage).toBe("function");
	});

	it("file-backed broker prompt builders reference the request file path", () => {
		const fakePath = "/tmp/artifacts/work-123/request.json";

		const codexPrompt = buildCodexFileBackedBrokerPrompt(fakePath);
		expect(codexPrompt).toContain(fakePath);
		expect(codexPrompt).toContain('"kind": "answer" | "review" | "clarification" | "failure"');
		expect(codexPrompt).toContain("Return ONLY valid JSON matching this schema:");

		const claudePrompt = buildClaudeFileBackedBrokerPrompt(fakePath);
		expect(claudePrompt).toContain(fakePath);
		expect(claudePrompt).toContain('"kind": "answer" | "review" | "clarification" | "failure"');
		expect(claudePrompt).toContain("Return ONLY valid JSON matching this schema:");
	});

	it("handleWork with artifactHandle uses file-backed spawn path regardless of attached session", async () => {
		const fakePty = createFakePty();
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;

		const codexProvider = createCodexProvider({ executable: "nonexistent-codex-binary", execArgs: [] });
		const codexSession = createCodexLiveSession({
			config: { executable: "nonexistent-codex-binary", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty() {
				return fakePty;
			},
		});
		codexProvider.attachInteractiveSession?.(codexSession);

		// handleWork with an artifactHandle must use the spawn path (not PTY).
		// A nonexistent binary will cause a failure reply — not a thrown exception.
		const codexReply = await codexProvider.handleWork(
			{
				requestedAction: "answer",
				instruction: "Test",
				collabId: "c1",
				threadId: "t1",
				workItemId: "w1",
			},
			{ artifactHandle: stubHandle },
		);
		expect(codexReply.kind).toBe("failure");
		expect(codexReply.transitionIntent).toBe("failed");

		const claudeProvider = createClaudeProvider({ executable: "nonexistent-claude-binary", execArgs: [] });
		const claudeSession = createClaudeLiveSession({
			config: { executable: "nonexistent-claude-binary", execArgs: ["-p"] },
			cwd: "/tmp",
			stdout,
			createPty() {
				return fakePty;
			},
		});
		claudeProvider.attachInteractiveSession?.(claudeSession);

		const claudeReply = await claudeProvider.handleWork(
			{
				requestedAction: "answer",
				instruction: "Test",
				collabId: "c1",
				threadId: "t1",
				workItemId: "w1",
			},
			{ artifactHandle: stubHandle },
		);
		expect(claudeReply.kind).toBe("failure");
		expect(claudeReply.transitionIntent).toBe("failed");
	});
});
