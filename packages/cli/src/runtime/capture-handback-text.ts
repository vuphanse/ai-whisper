import type Database from "better-sqlite3";
import {
	acquireCaptureLease,
	releaseCaptureLease,
	type LeaseOptions,
} from "@ai-whisper/broker";
import {
	computeOrderedJaccard,
	computeContainment,
} from "./mounted-turn-owned-relay.js";

export type CaptureHandbackStatus = "captured" | "degraded_pty_only";

export interface CaptureHandbackResult {
	status: CaptureHandbackStatus;
	/** Captured clipboard text on success; null when degraded to PTY-only. */
	text: string | null;
	/** True when changeCount flagged a foreign write during the held window. */
	interferenceDetected: boolean;
}

export interface CaptureHandbackInput {
	db: Database.Database;
	collabId: string;
	pid: number;
	/** This collab's PTY turn text, used by the interference content check. */
	turnText: string;
	/** Runs one /copy injection + clipboard read; returns text or null. */
	runCapture: () => Promise<string | null>;
	/** Reads NSPasteboard.changeCount, or null when the helper is unavailable. */
	readChangeCount: () => Promise<number | null>;
	leaseOptions?: LeaseOptions;
	/** Bounded poll-acquire. */
	acquireMaxWaitMs?: number;
	acquireBackoffMs?: number;
	/** Interference re-capture bound (default 2). */
	recaptureAttempts?: number;
	recaptureBackoffMs?: number;
	sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) =>
	new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Content-acceptance check that BYPASSES the >=100-char fast-path. Accepts only
 *  on normalized identity or classifyCapture's similarity thresholds. */
function contentMatches(turnText: string, clip: string): boolean {
	const t = turnText.trim();
	const c = clip.trim();
	if (c.length === 0) return false;
	if (t === c) return true; // exact/normalized identity
	const jaccard = computeOrderedJaccard(t, c);
	const containment = computeContainment(c, t);
	return jaccard >= 0.6 || containment >= 0.8;
}

/**
 * Lease-wrapped clipboard capture. Acquires the host-global capture lease (or
 * degrades to PTY-only on timeout — never a racy read), snapshots changeCount
 * (C0), runs the capture, re-reads changeCount (Cn). Cn-C0 == 1 ⇒ clean accept.
 * Cn-C0 > 1 ⇒ interference ladder (re-capture → content-accept → PTY-only).
 * Releases in finally. When readChangeCount yields null the ownership check is
 * skipped and the capture is accepted on the lease alone.
 */
export async function captureHandbackText(
	input: CaptureHandbackInput,
): Promise<CaptureHandbackResult> {
	const sleep = input.sleep ?? defaultSleep;
	const acquireMaxWaitMs = input.acquireMaxWaitMs ?? 4000;
	const acquireBackoffMs = input.acquireBackoffMs ?? 50;
	const recaptureAttempts = input.recaptureAttempts ?? 2;
	const recaptureBackoffMs = input.recaptureBackoffMs ?? 50;

	// --- bounded poll-acquire; degrade to PTY-only on timeout (no racy read) ---
	let acquired = false;
	const deadline = Date.now() + acquireMaxWaitMs;
	for (;;) {
		try {
			acquired = acquireCaptureLease(
				input.db,
				input.collabId,
				input.pid,
				input.leaseOptions,
			);
		} catch {
			// Defense in depth: a residual SQLITE_BUSY ("database is locked") past
			// busy_timeout must not propagate — an uncaught throw here is swallowed
			// upstream into an empty handback that halts the workflow. Treat it as
			// "not acquired" and retry within the deadline, then degrade to PTY-only.
			acquired = false;
		}
		if (acquired) break;
		if (Date.now() >= deadline) break;
		await sleep(acquireBackoffMs);
	}
	if (!acquired) {
		return { status: "degraded_pty_only", text: null, interferenceDetected: false };
	}

	try {
		let interferenceDetected = false;
		// attempt 0 = initial capture; up to recaptureAttempts re-captures after.
		for (let attempt = 0; attempt <= recaptureAttempts; attempt += 1) {
			if (attempt > 0) await sleep(recaptureBackoffMs);

			const c0 = await input.readChangeCount();
			const clip = await input.runCapture();
			const cn = await input.readChangeCount();

			// changeCount unavailable on either read → skip the ownership check.
			const checkAvailable = c0 !== null && cn !== null;
			const interfered = checkAvailable && cn - c0 > 1;

			if (clip === null || clip.trim().length === 0) {
				// Empty capture. If interference was detected, a foreign write may have
				// clobbered our /copy before it landed — re-capture under the held lease.
				// Otherwise (no interference, or check unavailable) this is a genuine
				// "no clipboard change": return captured/null so the relay applies the
				// existing no_response_captured* behavior, NOT a PTY-text degrade.
				if (interfered) {
					interferenceDetected = true;
					continue;
				}
				return { status: "captured", text: null, interferenceDetected };
			}

			const clean = checkAvailable ? cn - c0 === 1 : true;

			if (clean) {
				return { status: "captured", text: clip, interferenceDetected };
			}

			// Interference: accept ONLY on content match (fast-path bypassed).
			interferenceDetected = true;
			if (contentMatches(input.turnText, clip)) {
				return { status: "captured", text: clip, interferenceDetected: true };
			}
			// else fall through to next re-capture attempt
		}
		// Every attempt showed interference and never content-validated.
		return { status: "degraded_pty_only", text: null, interferenceDetected: true };
	} finally {
		releaseCaptureLease(input.db, input.collabId);
	}
}
