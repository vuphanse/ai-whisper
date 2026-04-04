import { z } from "zod";
import type { InteractiveSessionController } from "./interactive-session.js";
import type { ProviderCapabilities } from "./provider-capabilities.js";
import type { ProviderIdentity } from "./provider-identity.js";
import { replyKinds, transitionIntents } from "./literals.js";

export const mockProviderReplySchema = z.object({
	kind: z.enum(replyKinds),
	content: z.string().min(1),
	transitionIntent: z.enum(transitionIntents).nullable(),
});

export type ProviderReply = z.infer<typeof mockProviderReplySchema>;

/** @deprecated Use ProviderReply instead. */
export type MockProviderReply = ProviderReply;

export type ProviderWorkRequest = {
	readonly workItemId: string;
	readonly collabId: string;
	readonly threadId: string;
	readonly requestedAction: string;
	readonly instruction: string;
};

export interface CompanionProvider {
	getIdentity(): ProviderIdentity;
	getCapabilities(): ProviderCapabilities;
	getHealthState(): "healthy" | "degraded" | "offline";
	handleWork(request: ProviderWorkRequest): Promise<ProviderReply>;
	attachInteractiveSession?(session: InteractiveSessionController): void;
}
