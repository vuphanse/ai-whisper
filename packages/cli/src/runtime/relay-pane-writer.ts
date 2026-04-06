import type { BrokerRuntime } from "@ai-whisper/broker";

export function createRelayPaneWriter(input: {
	broker: BrokerRuntime;
	collabId: string;
}) {
	return {
		relayDirective(event: {
			senderAgent: string;
			receiverAgent: string;
			instruction: string;
			now: string;
		}) {
			input.broker.control.appendRelayEvent({
				collabId: input.collabId,
				eventType: "relay_directive",
				senderAgent: event.senderAgent,
				receiverAgent: event.receiverAgent,
				content: event.instruction,
				now: event.now,
			});
		},

		relayResponse(event: {
			senderAgent: string;
			receiverAgent: string;
			replyKind: string;
			content: string;
			now: string;
		}) {
			input.broker.control.appendRelayEvent({
				collabId: input.collabId,
				eventType: "relay_response",
				senderAgent: event.senderAgent,
				receiverAgent: event.receiverAgent,
				content: event.content,
				now: event.now,
			});
		},

		status(event: { content: string; now: string }) {
			input.broker.control.appendRelayEvent({
				collabId: input.collabId,
				eventType: "status",
				senderAgent: null,
				receiverAgent: null,
				content: event.content,
				now: event.now,
			});
		},

		cancellation(event: { agent: string; content: string; now: string }) {
			input.broker.control.appendRelayEvent({
				collabId: input.collabId,
				eventType: "cancellation",
				senderAgent: event.agent,
				receiverAgent: null,
				content: event.content,
				now: event.now,
			});
		},
	};
}
