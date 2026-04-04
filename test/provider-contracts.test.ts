import { afterEach, describe, expect, it, vi } from "vitest";
import {
	beginBrokerReply,
	companionHeartbeatSchema,
	companionRegistrationSchema,
	createProviderIdentity,
	endBrokerReply,
	mockProviderReplySchema,
	providerCapabilitiesSchema,
	type BrokerArtifactHandle,
} from "../packages/shared/src/index.ts";
import {
	createCodexLiveSession,
	createCodexProvider,
} from "../packages/adapter-codex/src/index.ts";
import {
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
	afterEach(() => {
		vi.useRealTimers();
	});

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

	it("handleWork calls runBrokerWork on attached interactive session when artifactHandle is provided", async () => {
		vi.useFakeTimers();

		const fakePty = createFakePty();
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;

		const codexSession = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty() {
				return fakePty;
			},
		});
		await codexSession.start();
		const codexProvider = createCodexProvider({ executable: "codex", execArgs: [] });
		codexProvider.attachInteractiveSession!(codexSession);

		const request = {
			workItemId: "work_contract_test",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question" as const,
			instruction: "test",
		};

		const replyPromise = codexProvider.handleWork(request, { artifactHandle: stubHandle });
		await vi.advanceTimersByTimeAsync(75);
		await vi.advanceTimersByTimeAsync(300);

		fakePty.emitData(
			`${beginBrokerReply("work_contract_test")}\n{"kind":"answer","content":"ok","transitionIntent":"completed"}\n${endBrokerReply("work_contract_test")}\n`,
		);

		const reply = await replyPromise;
		expect(reply.kind).toBe("answer");
	});

	it("handleWork throws when session is attached but artifactHandle is absent", () => {
		const codexProvider = createCodexProvider({ executable: "codex", execArgs: [] });
		const claudeProvider = createClaudeProvider({ executable: "claude", execArgs: [] });

		const fakePty = createFakePty();
		const stdout = {
			write() {
				return true;
			},
		} as unknown as NodeJS.WritableStream;

		const session = createCodexLiveSession({
			config: { executable: "codex", execArgs: [] },
			cwd: "/tmp",
			stdout,
			createPty() {
				return fakePty;
			},
		});

		codexProvider.attachInteractiveSession!(session);
		claudeProvider.attachInteractiveSession!(session);

		const request = {
			workItemId: "work_missing_handle",
			collabId: "collab_smoke",
			threadId: "thread_smoke",
			requestedAction: "answer_question" as const,
			instruction: "test",
		};

		expect(() => codexProvider.handleWork(request, {})).toThrow(
			"BrokerArtifactHandle is required when an interactive session is attached",
		);
		expect(() => codexProvider.handleWork(request)).toThrow(
			"BrokerArtifactHandle is required when an interactive session is attached",
		);
		expect(() => claudeProvider.handleWork(request, {})).toThrow(
			"BrokerArtifactHandle is required when an interactive session is attached",
		);
		expect(() => claudeProvider.handleWork(request)).toThrow(
			"BrokerArtifactHandle is required when an interactive session is attached",
		);
	});
});
