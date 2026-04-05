import {
	artifactManifestSchema,
	attachClaimSchema,
	brokerSchemaVersion,
	collabSchema,
	companionRegistrationSchema,
	providerCapabilitiesSchema,
	providerIdentitySchema,
	replySchema,
	sessionBindingSchema,
	sessionSchema,
	threadSchema,
	workItemSchema,
	type ProviderCapabilities,
	type ProviderIdentity,
} from "@ai-whisper/shared";
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import {
	appendEvent,
	listEventsForCollab,
} from "../storage/repositories/event-log-repository.js";
import { insertArtifactManifest } from "../storage/repositories/artifact-manifest-repository.js";
import {
	getAttachClaim,
	insertAttachClaim,
	markAttachClaimConsumed,
} from "../storage/repositories/attach-claim-repository.js";
import {
	createCompanionAck,
	getCompanionSession,
	insertCompanionSession,
	updateCompanionHeartbeat,
} from "../storage/repositories/companion-session-repository.js";
import {
	insertCollab,
	getCollab,
} from "../storage/repositories/collab-repository.js";
import {
	insertReply,
	listRepliesForThread,
} from "../storage/repositories/reply-repository.js";
import {
	getSessionBinding,
	listSessionBindingsForCollab,
	upsertSessionBinding,
} from "../storage/repositories/session-binding-repository.js";
import {
	insertSession,
	getSession,
	listSessionsForCollab as listSessions,
	updateSessionHealth,
} from "../storage/repositories/session-repository.js";
import {
	getThread,
	insertThread,
	listThreadsForCollab,
	markOnlyThreadActive,
	updateThreadState,
	updateThreadTurnIndex,
} from "../storage/repositories/thread-repository.js";
import {
	getWorkItem,
	insertWorkItem,
	listWorkItemsForThread,
	markWorkItemCompleted,
	markWorkItemDelivered,
	markWorkItemFailed,
} from "../storage/repositories/work-item-repository.js";

function normalizeTimestampForEventId(timestamp: string): string {
	return timestamp.replace(/[^0-9]/g, "");
}

function buildEventId(
	kind: string,
	subjectId: string,
	timestamp: string,
): string {
	return `evt_${kind}_${subjectId}_${normalizeTimestampForEventId(timestamp)}`;
}

export function createControlService(db: Database.Database) {
	return {
		startCollab(input: {
			collabId: string;
			workspaceRoot: string;
			displayName: string;
			now: string;
		}) {
			const collab = collabSchema.parse({
				version: 1,
				collabId: input.collabId,
				workspaceRoot: input.workspaceRoot,
				displayName: input.displayName,
				status: "active",
				createdAt: input.now,
				updatedAt: input.now,
			});

			insertCollab(db, collab);
			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId("collab_started", collab.collabId, input.now),
				eventType: "collab.started",
				collabId: collab.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.now,
				payload: { status: "started" },
			});

			return collab;
		},
		registerSession(input: {
			sessionId: string;
			collabId: string;
			agentType: "codex" | "claude";
			capabilities: Record<string, unknown>;
			now: string;
		}) {
			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			const session = sessionSchema.parse({
				version: 1,
				sessionId: input.sessionId,
				collabId: input.collabId,
				agentType: input.agentType,
				registrationState: "registered",
				healthState: "healthy",
				capabilities: input.capabilities,
				registeredAt: input.now,
				lastSeenAt: input.now,
			});

			insertSession(db, session);

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId("session_registered", input.sessionId, input.now),
				eventType: "session.registered",
				collabId: input.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.now,
				payload: { status: "registered" },
			});

			return session;
		},
		createThread(input: {
			threadId: string;
			collabId: string;
			title: string;
			createdBySessionId: string;
			now: string;
		}) {
			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			const thread = threadSchema.parse({
				version: 1,
				threadId: input.threadId,
				collabId: input.collabId,
				title: input.title,
				threadState: "in_progress",
				baseContextRef: null,
				currentTurnIndex: 0,
				active: true,
				createdBySessionId: input.createdBySessionId,
				createdAt: input.now,
				updatedAt: input.now,
			});

			const txn = db.transaction(() => {
				markOnlyThreadActive(db, input.collabId, null);
				insertThread(db, thread);
				markOnlyThreadActive(db, input.collabId, thread.threadId);

				appendEvent(db, {
					version: brokerSchemaVersion,
					eventId: buildEventId("thread_created", input.threadId, input.now),
					eventType: "thread.created",
					collabId: input.collabId,
					workspaceRoot: collab.workspaceRoot,
					timestamp: input.now,
					payload: { status: "created" },
				});
			});

			txn();
			return thread;
		},
		enqueueWorkItem(input: {
			workItemId: string;
			threadId: string;
			collabId: string;
			senderSessionId: string;
			targetSessionId: string;
			requestedAction:
				| "review_plan"
				| "implement_plan"
				| "review_diff"
				| "validate_against_plan"
				| "answer_question"
				| "request_clarification";
			instruction: string;
			contextPacket: Record<string, unknown>;
			artifactManifestIds: string[];
			now: string;
		}) {
			const thread = getThread(db, input.threadId);

			if (!thread) {
				throw new Error(`Unknown thread: ${input.threadId}`);
			}

			const nextTurn = thread.currentTurnIndex + 1;
			const workItem = workItemSchema.parse({
				version: 1,
				workItemId: input.workItemId,
				threadId: input.threadId,
				collabId: input.collabId,
				turnIndex: nextTurn,
				senderSessionId: input.senderSessionId,
				targetSessionId: input.targetSessionId,
				requestedAction: input.requestedAction,
				instruction: input.instruction,
				contextPacket: input.contextPacket,
				deliveryState: "queued",
				artifactManifestIds: input.artifactManifestIds,
				createdAt: input.now,
				deliveredAt: null,
				completedAt: null,
			});

			if (workItem.contextPacket.kind === "delta" && !thread.baseContextRef) {
				throw new Error(
					"Delta context requires an existing thread base context",
				);
			}

			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			insertWorkItem(db, workItem);
			updateThreadTurnIndex(
				db,
				input.threadId,
				nextTurn,
				workItem.contextPacket.kind === "full"
					? workItem.workItemId
					: thread.baseContextRef,
				input.now,
			);

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId("workitem_queued", input.workItemId, input.now),
				eventType: "workitem.queued",
				collabId: input.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.now,
				payload: { status: "queued" },
			});

			return workItem;
		},
		ackWorkItemDelivered(input: { workItemId: string; deliveredAt: string }) {
			const workItem = getWorkItem(db, input.workItemId);

			if (!workItem) {
				throw new Error(`Unknown work item: ${input.workItemId}`);
			}

			const collab = getCollab(db, workItem.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${workItem.collabId}`);
			}

			markWorkItemDelivered(db, input.workItemId, input.deliveredAt);

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId(
					"workitem_delivered",
					input.workItemId,
					input.deliveredAt,
				),
				eventType: "workitem.delivered",
				collabId: workItem.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.deliveredAt,
				payload: { status: "delivered" },
			});
		},
		postReply(input: {
			replyId: string;
			threadId: string;
			collabId: string;
			workItemId: string;
			sourceSessionId: string;
			kind: "answer" | "review" | "clarification" | "failure";
			content: string;
			transitionIntent:
				| "in_progress"
				| "awaiting_user"
				| "completed"
				| "failed"
				| null;
			artifactManifestIds: string[];
			now: string;
		}) {
			const thread = getThread(db, input.threadId);

			if (!thread) {
				throw new Error(`Unknown thread: ${input.threadId}`);
			}

			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			const workItem = getWorkItem(db, input.workItemId);

			if (!workItem) {
				throw new Error(`Unknown work item: ${input.workItemId}`);
			}

			if (
				workItem.threadId !== input.threadId ||
				workItem.collabId !== input.collabId
			) {
				throw new Error(
					`Work item ${input.workItemId} does not belong to thread ${input.threadId} / collab ${input.collabId}`,
				);
			}

			const reply = replySchema.parse({
				version: 1,
				replyId: input.replyId,
				threadId: input.threadId,
				collabId: input.collabId,
				workItemId: input.workItemId,
				sourceSessionId: input.sourceSessionId,
				turnIndex: thread.currentTurnIndex,
				kind: input.kind,
				content: input.content,
				transitionIntent: input.transitionIntent,
				artifactManifestIds: input.artifactManifestIds,
				createdAt: input.now,
			});

			insertReply(db, reply);

			if (reply.kind === "failure") {
				markWorkItemFailed(db, input.workItemId, input.now);
			} else {
				markWorkItemCompleted(db, input.workItemId, input.now);
			}

			if (reply.transitionIntent) {
				updateThreadState(
					db,
					input.threadId,
					reply.transitionIntent,
					input.now,
				);
				appendEvent(db, {
					version: brokerSchemaVersion,
					eventId: buildEventId("thread_transition", input.replyId, input.now),
					eventType: "thread.transitioned",
					collabId: input.collabId,
					workspaceRoot: collab.workspaceRoot,
					timestamp: input.now,
					payload: { status: reply.transitionIntent },
				});
			}

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId("reply_posted", input.replyId, input.now),
				eventType: "reply.posted",
				collabId: input.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.now,
				payload: { status: reply.kind },
			});

			return reply;
		},
		attachArtifactManifest(input: {
			artifactManifestId: string;
			threadId: string;
			collabId: string;
			producedBySessionId: string;
			artifactCategory: "file_ref" | "diff" | "design_doc" | "plan_doc";
			entries: Array<{ path: string; kind: "file" | "diff" }>;
			summary: string;
			ownerType: "thread" | "work_item" | "reply";
			ownerId: string;
			now: string;
		}) {
			const manifest = artifactManifestSchema.parse({
				version: 1,
				artifactManifestId: input.artifactManifestId,
				threadId: input.threadId,
				collabId: input.collabId,
				producedBySessionId: input.producedBySessionId,
				artifactCategory: input.artifactCategory,
				entries: input.entries,
				summary: input.summary,
				createdAt: input.now,
			});

			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			insertArtifactManifest(db, manifest, {
				ownerType: input.ownerType,
				ownerId: input.ownerId,
				attachedAt: input.now,
			});

			appendEvent(db, {
				version: brokerSchemaVersion,
				eventId: buildEventId(
					"manifest_attached",
					input.artifactManifestId,
					input.now,
				),
				eventType: "artifact.manifest_attached",
				collabId: input.collabId,
				workspaceRoot: collab.workspaceRoot,
				timestamp: input.now,
				payload: { status: "attached" },
			});

			return manifest;
		},
		registerCompanion(input: {
			collabId: string;
			sessionId: string;
			provider: {
				providerId: string;
				toolFamily: string;
				providerVersion: string;
			};
			capabilities: {
				supportsDirectPackets: boolean;
				supportsNormalization: boolean;
				supportsRelayInterception: boolean;
				supportsLocalBuffering: boolean;
				supportsLaunchHooks: boolean;
				extensions: Record<string, unknown>;
			};
			now: string;
		}) {
			const collab = getCollab(db, input.collabId);

			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			const sessions = listSessions(db, input.collabId);
			if (!sessions.some((s) => s.sessionId === input.sessionId)) {
				throw new Error(
					`Unknown session: ${input.sessionId} in collab ${input.collabId}`,
				);
			}

			companionRegistrationSchema.parse({
				version: 1,
				collabId: input.collabId,
				sessionId: input.sessionId,
				provider: providerIdentitySchema.parse(input.provider),
				capabilities: providerCapabilitiesSchema.parse(input.capabilities),
				registeredAt: input.now,
			});

			const existing = getCompanionSession(db, input.collabId, input.sessionId);
			if (existing) {
				return createCompanionAck({
					collabId: input.collabId,
					sessionId: input.sessionId,
					sessionSecret: existing.sessionSecret,
					acceptedAt: input.now,
				});
			}

			const sessionSecret = nanoid(24);

			insertCompanionSession(db, {
				collabId: input.collabId,
				sessionId: input.sessionId,
				providerJson: JSON.stringify(input.provider),
				capabilitiesJson: JSON.stringify(input.capabilities),
				sessionSecret,
				registeredAt: input.now,
			});

			return createCompanionAck({
				collabId: input.collabId,
				sessionId: input.sessionId,
				sessionSecret,
				acceptedAt: input.now,
			});
		},
		pollQueuedWorkItem(input: {
			collabId: string;
			sessionId: string;
			sessionSecret: string;
		}) {
			const registration = getCompanionSession(
				db,
				input.collabId,
				input.sessionId,
			);

			if (!registration || registration.sessionSecret !== input.sessionSecret) {
				throw new Error("Invalid companion session secret");
			}

			const threadRows = listThreadsForCollab(db, input.collabId);

			for (const thread of threadRows) {
				const workItems = listWorkItemsForThread(db, thread.threadId);
				const next = workItems.find(
					(workItem) =>
						workItem.targetSessionId === input.sessionId &&
						workItem.deliveryState === "queued",
				);

				if (next) {
					return next;
				}
			}

			return null;
		},
		recordCompanionHeartbeat(input: {
			collabId: string;
			sessionId: string;
			sessionSecret: string;
			healthState: "healthy" | "degraded" | "offline";
			now: string;
		}) {
			const registration = getCompanionSession(
				db,
				input.collabId,
				input.sessionId,
			);

			if (!registration || registration.sessionSecret !== input.sessionSecret) {
				throw new Error("Invalid companion session secret");
			}

			updateCompanionHeartbeat(db, {
				collabId: input.collabId,
				sessionId: input.sessionId,
				healthState: input.healthState,
				sentAt: input.now,
			});

			updateSessionHealth(db, input.sessionId, input.healthState, input.now);
		},
		getThread(threadId: string) {
			return getThread(db, threadId);
		},
		getWorkItem(workItemId: string) {
			return getWorkItem(db, workItemId);
		},
		listThreads(collabId: string) {
			return listThreadsForCollab(db, collabId);
		},
		listReplies(threadId: string) {
			return listRepliesForThread(db, threadId);
		},
		listSessions(collabId: string) {
			return listSessions(db, collabId);
		},
		listEventsForCollab(collabId: string) {
			return listEventsForCollab(db, collabId);
		},
		issueAttachClaim(input: {
			collabId: string;
			agentType: "codex" | "claude";
			mode: "attach" | "rebind";
			now: string;
			expiresAt: string;
		}) {
			const collab = getCollab(db, input.collabId);
			if (!collab) {
				throw new Error(`Unknown collab: ${input.collabId}`);
			}

			const claimId = `claim_${nanoid(16)}`;
			const secret = randomBytes(16).toString("hex");

			const claim = attachClaimSchema.parse({
				version: 1,
				claimId,
				collabId: input.collabId,
				agentType: input.agentType,
				mode: input.mode,
				secret,
				status: "pending",
				createdAt: input.now,
				expiresAt: input.expiresAt,
				consumedAt: null,
			});

			insertAttachClaim(db, claim);

			// If rebind mode, preserve the existing active session but enter pending_attach state
			const existing = getSessionBinding(db, input.collabId, input.agentType);
			const existingSessionId = existing?.activeSessionId ?? null;
			const existingSource = existing?.bindingSource ?? null;

			upsertSessionBinding(
				db,
				sessionBindingSchema.parse({
					version: 1,
					collabId: input.collabId,
					agentType: input.agentType,
					bindingState: "pending_attach",
					activeSessionId: existingSessionId,
					bindingSource: existingSource,
					pendingClaimId: claimId,
					pendingClaimExpiresAt: input.expiresAt,
					updatedAt: input.now,
				}),
			);

			return claim;
		},
		completeAttachClaim(input: {
			claimId: string;
			secret: string;
			sessionId: string;
			provider: ProviderIdentity;
			capabilities: ProviderCapabilities;
			now: string;
			bindingSource: "launched" | "attached";
		}) {
			const claim = getAttachClaim(db, input.claimId);
			if (!claim) {
				throw new Error(`Unknown attach claim: ${input.claimId}`);
			}
			if (claim.status !== "pending") {
				throw new Error(
					`Attach claim ${input.claimId} has already been consumed (status: ${claim.status})`,
				);
			}
			if (claim.secret !== input.secret) {
				throw new Error("Invalid attach claim secret");
			}

			// Register the session if it doesn't exist yet
			const existing = getSession(db, input.sessionId);
			if (!existing) {
				const session = sessionSchema.parse({
					version: 1,
					sessionId: input.sessionId,
					collabId: claim.collabId,
					agentType: claim.agentType,
					registrationState: "registered",
					healthState: "healthy",
					capabilities: input.capabilities,
					registeredAt: input.now,
					lastSeenAt: input.now,
				});
				insertSession(db, session);
			}

			// Update the binding to bound state
			upsertSessionBinding(
				db,
				sessionBindingSchema.parse({
					version: 1,
					collabId: claim.collabId,
					agentType: claim.agentType,
					bindingState: "bound",
					activeSessionId: input.sessionId,
					bindingSource: input.bindingSource,
					pendingClaimId: null,
					pendingClaimExpiresAt: null,
					updatedAt: input.now,
				}),
			);

			// Mark the claim consumed
			markAttachClaimConsumed(db, input.claimId, input.now);

			return {
				sessionId: input.sessionId,
				collabId: claim.collabId,
				agentType: claim.agentType,
				provider: providerIdentitySchema.parse(input.provider),
				capabilities: providerCapabilitiesSchema.parse(input.capabilities),
			};
		},
		listSessionBindings(collabId: string) {
			return listSessionBindingsForCollab(db, collabId);
		},
		resolveBoundSession(collabId: string, agentType: "codex" | "claude"): string {
			const binding = getSessionBinding(db, collabId, agentType);
			// Accept both 'bound' and 'pending_attach' states if there is an active session.
			// During a rebind the old session remains authoritative until the claim is completed.
			if (!binding || !binding.activeSessionId) {
				throw new Error(
					`No bound session for collab ${collabId} / agentType ${agentType}`,
				);
			}
			return binding.activeSessionId;
		},
		setSessionBinding(input: {
			collabId: string;
			agentType: "codex" | "claude";
			sessionId: string;
			bindingSource: "launched" | "attached";
			now: string;
		}) {
			upsertSessionBinding(
				db,
				sessionBindingSchema.parse({
					version: 1,
					collabId: input.collabId,
					agentType: input.agentType,
					bindingState: "bound",
					activeSessionId: input.sessionId,
					bindingSource: input.bindingSource,
					pendingClaimId: null,
					pendingClaimExpiresAt: null,
					updatedAt: input.now,
				}),
			);
		},
		assertActiveBinding(input: { collabId: string; sessionId: string }) {
			// Find a binding for this collab where the active session is the given sessionId
			const bindings = listSessionBindingsForCollab(db, input.collabId);
			const match = bindings.find(
				(b) =>
					b.bindingState === "bound" &&
					b.activeSessionId === input.sessionId,
			);
			if (!match) {
				throw new Error(
					`Session is no longer the active binding for this collab role.`,
				);
			}
		},
	};
}
