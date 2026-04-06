import type { BrokerRuntime } from "@ai-whisper/broker";

export function createContextInjector(input: {
	broker: BrokerRuntime;
	collabId: string;
	sessionId: string;
}) {
	return {
		injectContext(params: {
			userInput: string;
			activeThreadId: string;
		}): { injected: boolean; payload: string; summary: string | null } {
			const unconsumed = input.broker.control.listUnconsumedReplies({
				collabId: input.collabId,
				threadId: params.activeThreadId,
				forSessionId: input.sessionId,
			});

			if (unconsumed.length === 0) {
				return { injected: false, payload: params.userInput, summary: null };
			}

			const sessions = input.broker.control.listSessions(input.collabId);
			const contextBlocks = unconsumed.map((reply) => {
				const senderSession = sessions.find((s) => s.sessionId === reply.sourceSessionId);
				const senderName = senderSession?.agentType ?? "unknown";
				return `${senderName} ${reply.kind === "review" ? "reviewed and" : ""} responded:\n"${reply.content}"`;
			});

			const contextBody = `[Context from recent relay exchange]\n${contextBlocks.join("\n\n")}`;
			const payload = params.userInput
				? `${contextBody}\n\nUser instruction: ${params.userInput}`
				: contextBody;

			const senderNames = [...new Set(unconsumed.map((r) => {
				const s = sessions.find((s) => s.sessionId === r.sourceSessionId);
				return s?.agentType ?? "unknown";
			}))];
			const summary = `${senderNames.join(", ")} ${unconsumed.length === 1 ? "reply" : "replies"}: ${unconsumed.length} finding(s)`;

			input.broker.control.markRepliesConsumed({
				replyIds: unconsumed.map((r) => r.replyId),
				consumedBySessionId: input.sessionId,
			});

			return { injected: true, payload, summary };
		},

		enrichContextPacket(params: {
			activeThreadId: string;
			basePacket: Record<string, unknown>;
		}): Record<string, unknown> {
			const unconsumed = input.broker.control.listUnconsumedReplies({
				collabId: input.collabId,
				threadId: params.activeThreadId,
				forSessionId: input.sessionId,
			});

			if (unconsumed.length === 0) {
				return params.basePacket;
			}

			const sessions = input.broker.control.listSessions(input.collabId);
			const contextLines = unconsumed.map((reply) => {
				const sender = sessions.find((s) => s.sessionId === reply.sourceSessionId);
				return `${sender?.agentType ?? "unknown"} ${reply.kind}: ${reply.content}`;
			});

			input.broker.control.markRepliesConsumed({
				replyIds: unconsumed.map((r) => r.replyId),
				consumedBySessionId: input.sessionId,
			});

			const existingState = String(params.basePacket.currentState ?? "");
			return {
				...params.basePacket,
				currentState: existingState
					? `${existingState}\n\nRelay context:\n${contextLines.join("\n")}`
					: `Relay context:\n${contextLines.join("\n")}`,
			};
		},
	};
}
