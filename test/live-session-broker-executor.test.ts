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

function makeArtifactService(): BrokerArtifactService {
	const service = {
		createArtifact: vi.fn(() => STUB_HANDLE),
		recordAttemptStart: vi.fn(),
		recordAttemptResult: vi.fn(),
		recordReplied: vi.fn(),
		recordConsumed: vi.fn(),
		recordFailed: vi.fn(),
		sweep: vi.fn(),
	} as unknown as BrokerArtifactService;
	return service;
}

function makeProvider(handleWorkImpl?: (req: ProviderWorkRequest, ctx?: ProviderWorkContext) => Promise<ProviderReply>): CompanionProvider {
	return {
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
		handleWork: handleWorkImpl
			? vi.fn(handleWorkImpl)
			: vi.fn(async (_req: ProviderWorkRequest, ctx?: ProviderWorkContext) => {
				ctx?.onAttemptStart?.(1, "test_strategy");
				return SUCCESS_REPLY;
			}),
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
		const artifactService = makeArtifactService();
		const provider = makeProvider();
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		await executor(BASE_REQUEST);

		expect(artifactService.createArtifact).toHaveBeenCalledWith(
			expect.objectContaining({ workItemId: BASE_REQUEST.workItemId }),
		);
	});

	it("artifact creation failure returns failure reply without calling provider.handleWork", async () => {
		const artifactService = makeArtifactService();
		vi.mocked(artifactService.createArtifact).mockImplementation(() => {
			throw new Error("disk full");
		});
		const provider = makeProvider();
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result.kind).toBe("failure");
		expect((result as { content: string }).content).toContain("disk full");
		expect(provider.handleWork).not.toHaveBeenCalled();
	});

	it("successful reply records replied and schedules recordConsumed after 5 seconds", async () => {
		const artifactService = makeArtifactService();
		const provider = makeProvider();
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result).toEqual(SUCCESS_REPLY);
		expect(artifactService.recordAttemptResult).toHaveBeenCalledWith(
			expect.objectContaining({ result: "replied" }),
		);
		expect(artifactService.recordReplied).toHaveBeenCalledWith(
			expect.objectContaining({ artifactHandle: STUB_HANDLE }),
		);

		// recordConsumed not yet called
		expect(artifactService.recordConsumed).not.toHaveBeenCalled();

		// Advance time past the 5000ms delay
		vi.advanceTimersByTime(5000);

		expect(artifactService.recordConsumed).toHaveBeenCalledWith(
			expect.objectContaining({ artifactHandle: STUB_HANDLE }),
		);
	});

	it("InteractiveBrokerError(submit_failed) records submit_failed and returns failure reply", async () => {
		const artifactService = makeArtifactService();
		// Throws before any attempt starts — onAttemptStart never called, so no attempt result.
		const provider = makeProvider(async () => {
			throw new InteractiveBrokerError("submit_failed", "could not submit");
		});
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result.kind).toBe("failure");
		expect(artifactService.recordAttemptResult).not.toHaveBeenCalled();
		expect(artifactService.recordFailed).toHaveBeenCalledWith(
			expect.objectContaining({ state: "submit_failed" }),
		);
	});

	it("InteractiveBrokerError(timed_out) records timed_out and returns failure reply", async () => {
		const artifactService = makeArtifactService();
		const provider = makeProvider(async (_req, ctx) => {
			ctx?.onAttemptStart?.(1, "test_strategy");
			throw new InteractiveBrokerError("timed_out", "provider timed out");
		});
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result.kind).toBe("failure");
		expect(artifactService.recordAttemptResult).toHaveBeenCalledWith(
			expect.objectContaining({ result: "timed_out" }),
		);
		expect(artifactService.recordFailed).toHaveBeenCalledWith(
			expect.objectContaining({ state: "timed_out" }),
		);
	});

	it("InteractiveBrokerError(invalid_reply) records invalid_reply and returns failure reply", async () => {
		const artifactService = makeArtifactService();
		const provider = makeProvider(async (_req, ctx) => {
			ctx?.onAttemptStart?.(1, "test_strategy");
			throw new InteractiveBrokerError("invalid_reply", "reply was malformed");
		});
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result.kind).toBe("failure");
		expect(artifactService.recordAttemptResult).toHaveBeenCalledWith(
			expect.objectContaining({ result: "invalid_reply" }),
		);
		expect(artifactService.recordFailed).toHaveBeenCalledWith(
			expect.objectContaining({ state: "invalid_reply" }),
		);
	});

	it("generic Error records submit_failed and returns failure reply", async () => {
		const artifactService = makeArtifactService();
		// Throws before any attempt starts — onAttemptStart never called, so no attempt result.
		const provider = makeProvider(async () => {
			throw new Error("something unexpected");
		});
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		const result = await executor(BASE_REQUEST);

		expect(result.kind).toBe("failure");
		expect(artifactService.recordAttemptResult).not.toHaveBeenCalled();
		expect(artifactService.recordFailed).toHaveBeenCalledWith(
			expect.objectContaining({ state: "submit_failed" }),
		);
	});

	it("sweep() is called during executor invocation", async () => {
		const artifactService = makeArtifactService();
		const sweepSpy = vi.mocked(artifactService.sweep);
		const provider = makeProvider();
		const executor = createLiveSessionBrokerExecutor({
			provider,
			artifactService,
			sessionId: "session_test",
		});

		await executor(BASE_REQUEST);
		vi.advanceTimersByTime(0);

		expect(sweepSpy).toHaveBeenCalledOnce();
	});
});
