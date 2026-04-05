import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { InteractiveBrokerError } from "../packages/shared/src/index.ts";
import type {
	BrokerArtifactHandle,
	CompanionProvider,
	ProviderReply,
	ProviderWorkContext,
	ProviderWorkRequest,
} from "../packages/shared/src/index.ts";
import type { BrokerArtifactService } from "../packages/cli/src/runtime/broker-artifact-service.ts";
import { createLiveSessionBrokerExecutor } from "../packages/cli/src/runtime/live-session-broker-executor.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const STUB_HANDLE: BrokerArtifactHandle = {
	workItemId: "work_test_001",
	artifactDirPath: "/tmp/artifacts/stub",
	requestFilePath: "/tmp/artifacts/stub/request.json",
	statusFilePath: "/tmp/artifacts/stub/status.json",
};

const BASE_REQUEST: ProviderWorkRequest = {
	workItemId: "work_test_001",
	collabId: "collab_test",
	threadId: "thread_test",
	requestedAction: "answer_question",
	instruction: "what is 2+2?",
};

const SUCCESS_REPLY: ProviderReply = {
	kind: "answer",
	content: "four",
	transitionIntent: "completed",
};

type ArtifactServiceMocks = {
	createArtifact: ReturnType<typeof vi.fn>;
	recordAttemptStart: ReturnType<typeof vi.fn>;
	recordAttemptResult: ReturnType<typeof vi.fn>;
	recordReplied: ReturnType<typeof vi.fn>;
	recordConsumed: ReturnType<typeof vi.fn>;
	recordFailed: ReturnType<typeof vi.fn>;
	sweep: ReturnType<typeof vi.fn>;
};

function makeArtifactService(): {
	service: BrokerArtifactService;
	mocks: ArtifactServiceMocks;
} {
	const mocks: ArtifactServiceMocks = {
		createArtifact: vi.fn(() => STUB_HANDLE),
		recordAttemptStart: vi.fn(),
		recordAttemptResult: vi.fn(),
		recordReplied: vi.fn(),
		recordConsumed: vi.fn(),
		recordFailed: vi.fn(),
		sweep: vi.fn(),
	};

	return {
		service: mocks as unknown as BrokerArtifactService,
		mocks,
	};
}

function makeProvider(
	handleWorkImpl?: (
		req: ProviderWorkRequest,
		ctx?: ProviderWorkContext,
	) => Promise<ProviderReply>,
): {
	provider: CompanionProvider;
	handleWork: ReturnType<typeof vi.fn>;
} {
	const handleWork = handleWorkImpl
		? vi.fn(handleWorkImpl)
		: vi.fn(() => Promise.resolve(SUCCESS_REPLY));

	return {
		handleWork,
		provider: {
			getIdentity: vi.fn(() => ({
				providerId: "test-provider",
				toolFamily: "codex",
			providerVersion: "1.0.0",
		})),
		getCapabilities: vi.fn(() => ({
			supportsDirectPackets: true,
			supportsNormalization: true,
			supportsRelayInterception: true,
			supportsLocalBuffering: false,
			supportsLaunchHooks: true,
				extensions: {},
			})),
			getHealthState: vi.fn(() => "healthy" as const),
			handleWork,
		},
	};
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createLiveSessionBrokerExecutor", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("artifact created only after workItemId exists in the request", async () => {
		const { service: artifactService, mocks } = makeArtifactService();
		const { provider } = makeProvider();
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		await executor(BASE_REQUEST);

		expect(mocks.createArtifact).toHaveBeenCalledWith(
			expect.objectContaining({ workItemId: BASE_REQUEST.workItemId }),
		);
	});

	it("artifact creation failure returns failure reply without calling provider.handleWork", async () => {
		const { service: artifactService, mocks } = makeArtifactService();
		mocks.createArtifact.mockImplementation(() => {
			throw new Error("disk full");
		});
		const { provider, handleWork } = makeProvider();
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result.kind).toBe("failure");
		expect((result as { content: string }).content).toContain("disk full");
		expect(handleWork).not.toHaveBeenCalled();
		expect(mocks.recordAttemptStart).not.toHaveBeenCalled();
	});

	it("successful reply records replied and schedules recordConsumed after 5 seconds", async () => {
		const { service: artifactService, mocks } = makeArtifactService();
		const { provider } = makeProvider();
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result).toEqual(SUCCESS_REPLY);
		expect(mocks.recordAttemptStart).toHaveBeenCalledOnce();
		expect(mocks.recordAttemptStart).toHaveBeenCalledWith(
			expect.objectContaining({ executionMode: "one_shot", attemptNumber: 1 }),
		);
		expect(mocks.recordAttemptResult).toHaveBeenCalledWith(
			expect.objectContaining({ result: "replied", attemptNumber: 1 }),
		);
		expect(mocks.recordReplied).toHaveBeenCalledWith(
			expect.objectContaining({ artifactHandle: STUB_HANDLE }),
		);

		// recordConsumed not yet called
		expect(mocks.recordConsumed).not.toHaveBeenCalled();

		// Advance time past the 5000ms delay
		vi.advanceTimersByTime(5000);

		expect(mocks.recordConsumed).toHaveBeenCalledWith(
			expect.objectContaining({ artifactHandle: STUB_HANDLE }),
		);
	});

	it("InteractiveBrokerError(submit_failed) records submit_failed and returns failure reply", async () => {
		const { service: artifactService, mocks } = makeArtifactService();
		const { provider } = makeProvider(() =>
			Promise.reject(
				new InteractiveBrokerError("submit_failed", "could not submit"),
			),
		);
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result.kind).toBe("failure");
		expect(mocks.recordAttemptStart).toHaveBeenCalledWith(
			expect.objectContaining({ executionMode: "one_shot" }),
		);
		expect(mocks.recordAttemptResult).toHaveBeenCalledWith(
			expect.objectContaining({ result: "submit_failed" }),
		);
		expect(mocks.recordFailed).toHaveBeenCalledWith(
			expect.objectContaining({ state: "submit_failed" }),
		);
	});

	it("InteractiveBrokerError(timed_out) records timed_out and returns failure reply", async () => {
		const { service: artifactService, mocks } = makeArtifactService();
		const { provider } = makeProvider(() =>
			Promise.reject(new InteractiveBrokerError("timed_out", "provider timed out")),
		);
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result.kind).toBe("failure");
		expect(mocks.recordAttemptStart).toHaveBeenCalledWith(
			expect.objectContaining({ executionMode: "one_shot" }),
		);
		expect(mocks.recordAttemptResult).toHaveBeenCalledWith(
			expect.objectContaining({ result: "timed_out" }),
		);
		expect(mocks.recordFailed).toHaveBeenCalledWith(
			expect.objectContaining({ state: "timed_out" }),
		);
	});

	it("InteractiveBrokerError(invalid_reply) records invalid_reply and returns failure reply", async () => {
		const { service: artifactService, mocks } = makeArtifactService();
		const { provider } = makeProvider(() =>
			Promise.reject(
				new InteractiveBrokerError("invalid_reply", "reply was malformed"),
			),
		);
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result.kind).toBe("failure");
		expect(mocks.recordAttemptStart).toHaveBeenCalledWith(
			expect.objectContaining({ executionMode: "one_shot" }),
		);
		expect(mocks.recordAttemptResult).toHaveBeenCalledWith(
			expect.objectContaining({ result: "invalid_reply" }),
		);
		expect(mocks.recordFailed).toHaveBeenCalledWith(
			expect.objectContaining({ state: "invalid_reply" }),
		);
	});

	it("generic Error records submit_failed and returns failure reply", async () => {
		const { service: artifactService, mocks } = makeArtifactService();
		const { provider } = makeProvider(() =>
			Promise.reject(new Error("something unexpected")),
		);
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result.kind).toBe("failure");
		expect(mocks.recordAttemptStart).toHaveBeenCalledWith(
			expect.objectContaining({ executionMode: "one_shot" }),
		);
		expect(mocks.recordAttemptResult).toHaveBeenCalledWith(
			expect.objectContaining({ result: "submit_failed", outputTail: "something unexpected" }),
		);
		expect(mocks.recordFailed).toHaveBeenCalledWith(
			expect.objectContaining({ state: "submit_failed" }),
		);
	});

	it("sweep() is called during executor invocation", async () => {
		const { service: artifactService, mocks } = makeArtifactService();
		const { provider } = makeProvider();
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		await executor(BASE_REQUEST);
		vi.advanceTimersByTime(0);

		expect(mocks.sweep).toHaveBeenCalledOnce();
	});
});
