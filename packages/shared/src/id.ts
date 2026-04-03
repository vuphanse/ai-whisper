import { z } from "zod";
import type { Brand } from "./brand.js";

const collabIdSchema = z.string().regex(/^collab_[a-z0-9_]+$/);
const eventIdSchema = z.string().regex(/^evt_[a-z0-9_]+$/);
const workItemIdSchema = z.string().regex(/^work_[a-z0-9_]+$/);

export type CollabId = Brand<string, "CollabId">;
export type EventId = Brand<string, "EventId">;
export type WorkItemId = Brand<string, "WorkItemId">;

export function createCollabId(value: string): CollabId {
  return collabIdSchema.parse(value) as CollabId;
}

export function createEventId(value: string): EventId {
  return eventIdSchema.parse(value) as EventId;
}

export function createWorkItemId(value: string): WorkItemId {
  return workItemIdSchema.parse(value) as WorkItemId;
}

export { collabIdSchema, eventIdSchema, workItemIdSchema };
