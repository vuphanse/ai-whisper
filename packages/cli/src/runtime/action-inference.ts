import type { WorkItem } from "@ai-whisper/shared";

export function inferRequestedAction(instruction: string): WorkItem["requestedAction"] {
  const lower = instruction.toLowerCase();
  if (lower.includes("review") && lower.includes("plan")) return "review_plan";
  if (lower.includes("implement") && lower.includes("plan")) return "implement_plan";
  if (lower.includes("review") && lower.includes("diff")) return "review_diff";
  if (lower.includes("validate")) return "validate_against_plan";
  if (lower.includes("clarif")) return "request_clarification";
  return "answer_question";
}
