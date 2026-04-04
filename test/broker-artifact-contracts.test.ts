import { describe, expect, it } from "vitest";
import type {
	BrokerArtifactHandle,
	CompanionProvider,
	ProviderReply,
	ProviderWorkContext,
	ProviderWorkRequest,
} from "../packages/shared/src/index.ts";
import { InteractiveBrokerError } from "../packages/shared/src/index.ts";

describe("broker artifact contracts", () => {
	it("BrokerArtifactHandle shape is exported and has the four required fields", () => {
		const handle: BrokerArtifactHandle = {
			workItemId: "work_001",
			artifactDirPath: "/tmp/artifacts/work_001",
			requestFilePath: "/tmp/artifacts/work_001/request.json",
			statusFilePath: "/tmp/artifacts/work_001/status.json",
		};

		expect(handle.workItemId).toBe("work_001");
		expect(handle.artifactDirPath).toBe("/tmp/artifacts/work_001");
		expect(handle.requestFilePath).toBe("/tmp/artifacts/work_001/request.json");
		expect(handle.statusFilePath).toBe("/tmp/artifacts/work_001/status.json");
	});

	it("CompanionProvider.handleWork is callable with and without context", async () => {
		const stubReply: ProviderReply = {
			kind: "review",
			content: "stub reply",
			transitionIntent: null,
		};

		const mockRequest: ProviderWorkRequest = {
			workItemId: "work_001",
			collabId: "collab_001",
			threadId: "thread_001",
			requestedAction: "solve",
			instruction: "do something",
		};

		const mockHandle: BrokerArtifactHandle = {
			workItemId: "work_001",
			artifactDirPath: "/tmp/artifacts/work_001",
			requestFilePath: "/tmp/artifacts/work_001/request.json",
			statusFilePath: "/tmp/artifacts/work_001/status.json",
		};

		// Compile check: mock that satisfies CompanionProvider interface
		const provider: CompanionProvider = {
			getIdentity: () => ({
				providerId: "mock",
				toolFamily: "mock-agent",
				providerVersion: "0.0.1",
			}),
			getCapabilities: () => ({
				supportsDirectPackets: false,
				supportsNormalization: false,
				supportsRelayInterception: false,
				supportsLocalBuffering: false,
				supportsLaunchHooks: false,
				extensions: {},
			}),
			getHealthState: () => "healthy",
			handleWork: async (_req, _ctx?) => stubReply,
		};

		// Without context
		const reply1 = await provider.handleWork(mockRequest);
		expect(reply1.kind).toBe("review");

		// With context (artifactHandle present)
		const context: ProviderWorkContext = { artifactHandle: mockHandle };
		const reply2 = await provider.handleWork(mockRequest, context);
		expect(reply2.kind).toBe("review");

		// With context (artifactHandle absent — optional field)
		const reply3 = await provider.handleWork(mockRequest, {});
		expect(reply3.kind).toBe("review");
	});

	it("InteractiveBrokerError preserves its code field at runtime", () => {
		const err1 = new InteractiveBrokerError("submit_failed", "could not submit");
		expect(err1.name).toBe("InteractiveBrokerError");
		expect(err1.code).toBe("submit_failed");
		expect(err1.message).toBe("could not submit");
		expect(err1.outputTail).toBeUndefined();
		expect(err1 instanceof Error).toBe(true);

		const err2 = new InteractiveBrokerError("timed_out", "request timed out", "last few lines");
		expect(err2.code).toBe("timed_out");
		expect(err2.outputTail).toBe("last few lines");

		const err3 = new InteractiveBrokerError("invalid_reply", "reply was malformed");
		expect(err3.code).toBe("invalid_reply");
		expect(err3.outputTail).toBeUndefined();
	});
});
