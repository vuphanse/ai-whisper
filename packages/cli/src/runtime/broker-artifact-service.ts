import fs from "node:fs";
import { join } from "node:path";
import type { BrokerArtifactHandle } from "@ai-whisper/shared";
import { getLiveSessionBrokerTempRoot } from "./paths.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type ArtifactState =
	| "pending"
	| "replied"
	| "consumed"
	| "timed_out"
	| "invalid_reply"
	| "submit_failed";

type AttemptResult = "timed_out" | "invalid_reply" | "submit_failed" | "replied";

interface StateTransition {
	at: string;
	state: ArtifactState;
	reason: string;
}

interface AttemptEntry {
	attemptNumber: number;
	submitStrategy: string;
	startedAt: string;
	result?: AttemptResult;
	endedAt?: string;
	outputTail?: string;
}

interface RequestFile {
	schemaVersion: 1;
	workItemId: string;
	collabId: string;
	threadId: string;
	requestedAction: string;
	instruction: string;
}

interface StatusFile {
	schemaVersion: 1;
	workItemId: string;
	provider: string;
	sessionId: string;
	requestFilePath: string;
	currentState: ArtifactState;
	createdAt: string;
	updatedAt: string;
	transitions: StateTransition[];
	attempts: AttemptEntry[];
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const ANSI_ESCAPE_RE = /\x1b\[[0-9;]*[a-zA-Z]/g;

function stripAnsi(text: string): string {
	return text.replace(ANSI_ESCAPE_RE, "");
}

function normalizeOutputTail(raw: string | undefined): string | undefined {
	if (raw === undefined) return undefined;
	const stripped = stripAnsi(raw);
	return stripped.length > 200 ? stripped.slice(-200) : stripped;
}

/**
 * Build a filesystem-safe directory name from an ISO timestamp and workItemId.
 * Replaces colons and dots so the name is safe on all platforms.
 */
function buildDirName(now: string, workItemId: string): string {
	const safe = now.replace(/[:.]/g, "-");
	return `${safe}-${workItemId}`;
}

function atomicWriteJson(filePath: string, data: unknown): void {
	const tmpPath = `${filePath}.tmp`;
	fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2));
	fs.renameSync(tmpPath, filePath);
}

function readStatusFile(statusFilePath: string): StatusFile {
	const raw = fs.readFileSync(statusFilePath, "utf8");
	return JSON.parse(raw) as StatusFile;
}

// ---------------------------------------------------------------------------
// Service class
// ---------------------------------------------------------------------------

export class BrokerArtifactService {
	private readonly tempRoot: string;

	constructor(tempRoot: string) {
		this.tempRoot = tempRoot;
	}

	createArtifact(input: {
		workItemId: string;
		collabId: string;
		threadId: string;
		requestedAction: string;
		instruction: string;
		provider: string;
		sessionId: string;
		now: string;
	}): BrokerArtifactHandle {
		const dirName = buildDirName(input.now, input.workItemId);
		const artifactDirPath = join(this.tempRoot, dirName);
		const requestFilePath = join(artifactDirPath, "request.json");
		const statusFilePath = join(artifactDirPath, "status.json");

		fs.mkdirSync(artifactDirPath, { recursive: true });

		const requestData: RequestFile = {
			schemaVersion: 1,
			workItemId: input.workItemId,
			collabId: input.collabId,
			threadId: input.threadId,
			requestedAction: input.requestedAction,
			instruction: input.instruction,
		};
		atomicWriteJson(requestFilePath, requestData);

		const statusData: StatusFile = {
			schemaVersion: 1,
			workItemId: input.workItemId,
			provider: input.provider,
			sessionId: input.sessionId,
			requestFilePath,
			currentState: "pending",
			createdAt: input.now,
			updatedAt: input.now,
			transitions: [
				{
					at: input.now,
					state: "pending",
					reason: "artifact_created",
				},
			],
			attempts: [],
		};
		atomicWriteJson(statusFilePath, statusData);

		return {
			workItemId: input.workItemId,
			artifactDirPath,
			requestFilePath,
			statusFilePath,
		};
	}

	recordAttemptStart(input: {
		artifactHandle: BrokerArtifactHandle;
		attemptNumber: number;
		submitStrategy: string;
		startedAt: string;
	}): void {
		const status = readStatusFile(input.artifactHandle.statusFilePath);
		const newAttempt: AttemptEntry = {
			attemptNumber: input.attemptNumber,
			submitStrategy: input.submitStrategy,
			startedAt: input.startedAt,
		};
		status.attempts.push(newAttempt);
		status.updatedAt = input.startedAt;
		atomicWriteJson(input.artifactHandle.statusFilePath, status);
	}

	recordAttemptResult(input: {
		artifactHandle: BrokerArtifactHandle;
		attemptNumber: number;
		result: AttemptResult;
		endedAt: string;
		outputTail?: string;
	}): void {
		const status = readStatusFile(input.artifactHandle.statusFilePath);
		const attempt = status.attempts.find((a) => a.attemptNumber === input.attemptNumber);
		if (attempt !== undefined) {
			attempt.result = input.result;
			attempt.endedAt = input.endedAt;
			const normalized = normalizeOutputTail(input.outputTail);
			if (normalized !== undefined) {
				attempt.outputTail = normalized;
			}
		}
		status.updatedAt = input.endedAt;
		atomicWriteJson(input.artifactHandle.statusFilePath, status);
	}

	recordReplied(input: { artifactHandle: BrokerArtifactHandle; at: string }): void {
		this.transitionState(input.artifactHandle, "replied", "replied", input.at);
	}

	recordConsumed(input: { artifactHandle: BrokerArtifactHandle; at: string }): void {
		this.transitionState(input.artifactHandle, "consumed", "consumed", input.at);
	}

	sweep(): void {
		try {
			if (!fs.existsSync(this.tempRoot)) return;
			const entries = fs.readdirSync(this.tempRoot);
			for (const entry of entries) {
				const dirPath = join(this.tempRoot, entry);
				try {
					const statusPath = join(dirPath, "status.json");
					if (!fs.existsSync(statusPath)) continue;
					const raw = fs.readFileSync(statusPath, "utf8");
					const status = JSON.parse(raw) as StatusFile;
					const updatedAt = new Date(status.updatedAt).getTime();
					const now = Date.now();
					const SIX_HOURS_MS = 6 * 60 * 60 * 1000;
					const TWELVE_HOURS_MS = 12 * 60 * 60 * 1000;

					const terminalStates: ArtifactState[] = [
						"consumed",
						"replied",
						"timed_out",
						"invalid_reply",
						"submit_failed",
					];

					const shouldDelete =
						(terminalStates.includes(status.currentState) &&
							now - updatedAt > SIX_HOURS_MS) ||
						(status.currentState === "pending" && now - updatedAt > TWELVE_HOURS_MS);

					if (shouldDelete) {
						fs.rmSync(dirPath, { recursive: true, force: true });
					}
				} catch {
					// best-effort: skip on any error
				}
			}
		} catch {
			// best-effort: never throw
		}
	}

	// ---------------------------------------------------------------------------
	// Private
	// ---------------------------------------------------------------------------

	private transitionState(
		artifactHandle: BrokerArtifactHandle,
		newState: ArtifactState,
		reason: string,
		at: string,
	): void {
		const status = readStatusFile(artifactHandle.statusFilePath);
		status.currentState = newState;
		status.updatedAt = at;
		status.transitions.push({ at, state: newState, reason });
		atomicWriteJson(artifactHandle.statusFilePath, status);
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBrokerArtifactService(): BrokerArtifactService {
	return new BrokerArtifactService(getLiveSessionBrokerTempRoot());
}
