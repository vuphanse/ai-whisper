export const brokerPackage = {
	name: "@ai-whisper/broker",
} as const;

export { brokerConfigSchema, type BrokerConfig } from "./config.js";
export { createControlService } from "./control/create-control-service.js";
export { createBrokerApp } from "./http/create-broker-app.js";
export {
	createBrokerRuntime,
	type BrokerRuntime,
} from "./runtime/create-broker-runtime.js";
export { applyMigrations } from "./storage/apply-migrations.js";
export { openDatabase } from "./storage/open-database.js";
export { getBrokerState } from "./storage/repositories/broker-state-repository.js";
export {
	createCompanionAck,
	getCompanionSession,
	insertCompanionSession,
	updateCompanionHeartbeat,
} from "./storage/repositories/companion-session-repository.js";
export {
	appendEvent,
	listEventsForCollab,
} from "./storage/repositories/event-log-repository.js";
export {
	getSession,
	insertSession,
	listSessionsForCollab,
	updateSessionHealth,
} from "./storage/repositories/session-repository.js";
export {
	insertCaptureDiagnostic,
	listCaptureDiagnosticsByCollab,
	listCaptureDiagnosticsByCollabAndChain,
	listCaptureDiagnosticsByHandoff,
	deleteCaptureDiagnosticsOlderThan,
	type RelayCaptureDiagnosticRecord,
	type CaptureStatus,
} from "./storage/repositories/relay-capture-diagnostics-repository.js";
export {
	insertEvaluatorDiagnostic,
	listEvaluatorDiagnosticsByCollab,
	listEvaluatorDiagnosticsByCollabAndChain,
	listEvaluatorDiagnosticsByHandoff,
	deleteEvaluatorDiagnosticsOlderThan,
	type RelayEvaluatorDiagnosticRecord,
	type EvaluatorOutcome,
} from "./storage/repositories/relay-evaluator-diagnostics-repository.js";
export { getWorkflowDefinition, listWorkflowTypes } from "./runtime/workflow-registry.js";
export {
	upsertWorkspace,
	getWorkspaceById,
	getWorkspaceByRoot,
	listWorkspaces,
	type WorkspaceRecord,
} from "./storage/repositories/workspace-repository.js";
