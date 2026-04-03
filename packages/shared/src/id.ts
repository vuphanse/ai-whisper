import { z } from "zod";
import type { Brand } from "./brand.js";

const collabIdSchema = z.string().regex(/^collab_[a-z0-9_]+$/);
const sessionIdSchema = z.string().regex(/^session_[a-z0-9_]+$/);
const threadIdSchema = z.string().regex(/^thread_[a-z0-9_]+$/);
const eventIdSchema = z.string().regex(/^evt_[a-z0-9_]+$/);
const workItemIdSchema = z.string().regex(/^work_[a-z0-9_]+$/);
const replyIdSchema = z.string().regex(/^reply_[a-z0-9_]+$/);
const artifactManifestIdSchema = z.string().regex(/^manifest_[a-z0-9_]+$/);

export type CollabId = Brand<string, "CollabId">;
export type SessionId = Brand<string, "SessionId">;
export type ThreadId = Brand<string, "ThreadId">;
export type EventId = Brand<string, "EventId">;
export type WorkItemId = Brand<string, "WorkItemId">;
export type ReplyId = Brand<string, "ReplyId">;
export type ArtifactManifestId = Brand<string, "ArtifactManifestId">;

export function createCollabId(value: string): CollabId {
  return collabIdSchema.parse(value) as CollabId;
}

export function createSessionId(value: string): SessionId {
  return sessionIdSchema.parse(value) as SessionId;
}

export function createThreadId(value: string): ThreadId {
  return threadIdSchema.parse(value) as ThreadId;
}

export function createEventId(value: string): EventId {
  return eventIdSchema.parse(value) as EventId;
}

export function createWorkItemId(value: string): WorkItemId {
  return workItemIdSchema.parse(value) as WorkItemId;
}

export function createReplyId(value: string): ReplyId {
  return replyIdSchema.parse(value) as ReplyId;
}

export function createArtifactManifestId(value: string): ArtifactManifestId {
  return artifactManifestIdSchema.parse(value) as ArtifactManifestId;
}

export {
  artifactManifestIdSchema,
  collabIdSchema,
  eventIdSchema,
  replyIdSchema,
  sessionIdSchema,
  threadIdSchema,
  workItemIdSchema,
};
