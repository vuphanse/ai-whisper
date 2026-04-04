# Live Session Relay Debugging Lessons

**Date:** 2026-04-04

## Purpose

Record the implementation obstacles that led Phase 6 live-session relay away from inline broker prompt injection and toward file-backed broker delivery.

This note is not a spec or an implementation plan. It is a compact engineering record of what failed, what was learned, and why the design changed.

## Original Direction

The initial Phase 6 runtime attempted to deliver broker work into attached Codex and Claude live sessions by injecting a structured prompt directly into the interactive TUI.

The intended model was:

- enqueue broker work through the shared collab and thread model
- inject a provider-specific prompt into the paired live session
- require the live session to emit the standard three-line framed reply
- parse the framed reply back into the broker reply model

This looked attractive because it preserved the live-session workflow without introducing additional on-disk request artifacts.

## What Failed

### 1. Prompt submission was not the same as broker work execution

A prompt could appear in the TUI composer without being truly submitted and processed by the agent.

Observed symptoms included:

- prompt text being echoed into the composer
- UI redraw and spinner activity without a valid framed reply
- different submit behavior between Codex and Claude

The core lesson was that “text entered into the session” and “broker work accepted by the session” are different states.

### 2. Long structured inline prompts were a poor fit for interactive TUIs

The broker prompt needed to carry structured work details, framing instructions, and output constraints. That made it long and machine-shaped.

This conflicted with the behavior of the interactive Codex and Claude UIs:

- multiline prompt insertion was fragile
- submit timing varied across providers
- short plain messages were more reliable than long structured ones

The core lesson was that interactive chat composers are optimized for short natural prompts, not large broker protocol payloads.

### 3. PTY transport issues and prompt-shape issues were easy to confuse

Several debugging rounds were required to separate:

- PTY launch failures
- stdin/raw-mode forwarding problems
- terminal capability negotiation
- submit-sequence behavior
- prompt-content reliability
- frame parsing errors

This matters because transport fixes alone did not solve the live relay problem. Even after PTY launch and input forwarding were corrected, long inline broker prompts remained unreliable.

### 4. Prompt echo polluted frame detection

The system could misread echoed prompt text or UI noise as broker frame markers unless parsing was carefully delayed and normalized.

This exposed another lesson:

- framed output is still a good contract
- but the runtime must distinguish real reply frames from echoed instructions and terminal repaint noise

### 5. Debug probes were useful, but not a product design

Manual probe modes and submit experiments helped identify provider behavior, but they did not produce a stable supported runtime path by themselves.

The project needed a product-level correction, not more ad hoc prompt tuning.

## Why File-Backed Delivery Won

File-backed broker delivery keeps the user-visible live-session workflow while removing the least reliable part of the previous design: stuffing the full broker request into the TUI composer.

The new shape is:

- the coordinator enqueues broker work as before
- after `workItemId` exists, it writes an authoritative `request.json`
- the live-session adapter injects only a short prompt that points to the file
- the live session reads structured broker work from disk
- the reply still comes back through the existing three-line framed protocol

This is better because:

- the injected message becomes short and TUI-friendly
- the structured request is preserved exactly on disk
- artifact retention gives better debugging evidence than prompt echo tails
- the coordinator can own lifecycle, retention, and cleanup without pushing that policy into adapters

## Architectural Consequences

The file-backed redesign does not change the high-level Phase 6 goal. Relay still happens inside attached live sessions.

What it does change is the internal delivery model:

- `BrokerArtifactService` becomes a coordinator-owned runtime component
- broker request artifacts move to a machine temp root instead of the user workspace
- `request.json` becomes the authoritative source of truth for the provider turn
- adapters consume artifact handles but do not own artifact lifecycle
- long inline broker prompt injection is no longer a supported runtime path

## What Remains True

The redesign does **not** change these fundamentals:

- the broker and thread model remain the source of truth
- the live-session relay grammar remains intentionally small
- the CLI is still the escape hatch for new-thread flows requiring explicit artifacts
- the framed three-line reply contract remains the reply transport contract
- the broker itself should remain terminal-agnostic even if host-side companions use interactive terminal control locally

## Reusable Lessons

These lessons likely apply beyond this specific feature:

- do not assume PTY control is enough to make interactive TUIs reliable machine-protocol transports
- short interactive instructions are often more robust than long structured prompts
- when a system needs both debuggability and deterministic input, retained artifacts are often a better fit than injecting large protocol payloads inline
- transport debugging and prompt-design debugging should be separated early, or the failure modes become hard to reason about

## Related Records

- Debugging checkpoint commit: `2fc6160 chore: checkpoint live-session relay debugging evidence`
- Phase 6 design spec: [`2026-04-04-ai-whisper-phase-6-in-session-relay-workflow-design.md`](/Users/vuphan/Dev/ai-whisper/docs/superpowers/specs/2026-04-04-ai-whisper-phase-6-in-session-relay-workflow-design.md)
- File-backed implementation plan: [`2026-04-04-ai-whisper-phase-6-file-backed-live-session-broker-prompt.md`](/Users/vuphan/Dev/ai-whisper/docs/superpowers/plans/2026-04-04-ai-whisper-phase-6-file-backed-live-session-broker-prompt.md)
