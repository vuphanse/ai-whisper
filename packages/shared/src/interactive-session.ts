import type { ProviderReply, ProviderWorkRequest } from "./provider-contract.js";
import type { relayTargets } from "./relay-host.js";

export type InteractiveSessionTarget = (typeof relayTargets)[number];

export interface InteractiveSessionController {
	start(): Promise<void>;
	stop(): Promise<void>;
	writeUserInput(data: string): void;
	sendLocalMessage(message: string): void;
	runBrokerWork(request: ProviderWorkRequest): Promise<ProviderReply>;
}
