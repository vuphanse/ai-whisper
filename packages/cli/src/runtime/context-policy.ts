import type { WorkItem } from "@ai-whisper/shared";

const artifactRequiredActions = new Set<WorkItem["requestedAction"]>([
	"review_plan",
	"implement_plan",
	"review_diff",
	"validate_against_plan",
]);

export function requiresExplicitArtifacts(
	action: WorkItem["requestedAction"],
): boolean {
	return artifactRequiredActions.has(action);
}
