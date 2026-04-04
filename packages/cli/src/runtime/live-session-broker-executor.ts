import { InteractiveBrokerError } from "@ai-whisper/shared";
import type { CompanionProvider, ProviderReply, ProviderWorkRequest } from "@ai-whisper/shared";
import type { BrokerArtifactService } from "./broker-artifact-service.js";

export function createLiveSessionBrokerExecutor(input: {
	provider: CompanionProvider;
	artifactService: BrokerArtifactService;
	sessionId: string;
}): (request: ProviderWorkRequest) => Promise<ProviderReply> {
	return async (request: ProviderWorkRequest): Promise<ProviderReply> => {
		const providerIdentity = input.provider.getIdentity().toolFamily;

		let artifactHandle;
		try {
			artifactHandle = input.artifactService.createArtifact({
				workItemId: request.workItemId,
				collabId: request.collabId,
				threadId: request.threadId,
				requestedAction: request.requestedAction,
				instruction: request.instruction,
				provider: providerIdentity,
				sessionId: input.sessionId,
				now: new Date().toISOString(),
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			return { kind: "failure", content: message, transitionIntent: "failed" };
		}

		// Sweep best-effort off the critical path — deferred to next event loop tick.
		setTimeout(() => { input.artifactService.sweep(); }, 0);

		input.artifactService.recordAttemptStart({
			artifactHandle,
			attemptNumber: 1,
			executionMode: "one_shot",
			promptSummary: "file-backed one-shot provider execution",
			startedAt: new Date().toISOString(),
		});

		let reply: ProviderReply;
		try {
			reply = await input.provider.handleWork(request, {
				artifactHandle,
			});
		} catch (err) {
			if (err instanceof InteractiveBrokerError) {
				const code = err.code;
				input.artifactService.recordAttemptResult({
					artifactHandle,
					attemptNumber: 1,
					result: code,
					endedAt: new Date().toISOString(),
					...(err.outputTail !== undefined ? { outputTail: err.outputTail } : {}),
				});
				input.artifactService.recordFailed({
					artifactHandle,
					state: code,
					at: new Date().toISOString(),
				});
				return { kind: "failure", content: err.message, transitionIntent: "failed" };
			}

			const message = err instanceof Error ? err.message : String(err);
			input.artifactService.recordAttemptResult({
				artifactHandle,
				attemptNumber: 1,
				result: "submit_failed",
				endedAt: new Date().toISOString(),
				outputTail: message,
			});
			input.artifactService.recordFailed({
				artifactHandle,
				state: "submit_failed",
				at: new Date().toISOString(),
			});
			return { kind: "failure", content: message, transitionIntent: "failed" };
		}

		input.artifactService.recordAttemptResult({
			artifactHandle,
			attemptNumber: 1,
			result: "replied",
			endedAt: new Date().toISOString(),
		});

		input.artifactService.recordReplied({
			artifactHandle,
			at: new Date().toISOString(),
		});

		setTimeout(() => {
			try {
				input.artifactService.recordConsumed({ artifactHandle, at: new Date().toISOString() });
			} catch {
				// status file may no longer exist; ignore
			}
		}, 5000);

		return reply;
	};
}
