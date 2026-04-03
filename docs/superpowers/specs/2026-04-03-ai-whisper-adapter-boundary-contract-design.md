# ai-whisper Adapter Boundary Contract Design

**Date:** 2026-04-03

## Goal

Define a host-agnostic adapter boundary contract for `ai-whisper` v1 that:

- supports Codex and Claude as the first built-in providers
- keeps the broker and companion layers generic
- allows future integration of additional AI tools
- separates shared contract responsibilities from provider-specific implementation details

This document defines the provider boundary, capability model, and extension strategy. It does not define final code-level interfaces or provider packaging details.

## Design Inputs

This design builds on the approved architecture and companion decisions:

- adapters should be tool-agnostic rather than Codex/Claude-specific in the core design
- v1 should ship built-in providers, but the contract should allow external providers later
- a live host should be modeled as a generic collaboration endpoint
- the shared contract should support namespaced optional extensions
- provider discovery should support a built-in registry with optional external registration points
- the shared contract should use a medium-sized surface
- launch should be optional through provider hooks rather than required in the core contract
- direct broker-valid packets are preferred, with explicit normalization hooks as fallback
- relay interception should be represented as a shared capability but implemented by each provider internally
- provider identity should include `providerId`, `toolFamily`, and `providerVersion`
- capability negotiation should establish a baseline at attach time and allow structured capability updates later

## Design Overview

The adapter boundary should be modeled as a provider contract for generic collaboration endpoints.

The core system should not think in terms of “Codex adapter” or “Claude adapter” as privileged special cases. It should think in terms of providers that satisfy a shared contract.

In v1:

- `openai-codex` and `anthropic-claude-code` are built-in providers

In future versions:

- additional providers may register against the same boundary contract

## Provider Model

A provider represents one integration family that can create or bind live collaboration endpoints.

### Core provider identity

Provider identity should be represented with structured metadata rather than a single short name.

Required conceptual fields:

- `providerId`
- `toolFamily`
- `providerVersion`

### Example identities

- `providerId: "openai-codex"`
- `toolFamily: "codex"`
- `providerVersion: "1.0.0"`

- `providerId: "anthropic-claude-code"`
- `toolFamily: "claude-code"`
- `providerVersion: "1.0.0"`

### Rationale

This avoids ambiguity between:

- the specific provider implementation
- the broader tool family it serves
- the version of the provider contract or implementation in use

## Collaboration Endpoint Abstraction

The shared contract should model a host session as a generic collaboration endpoint.

### Endpoint responsibilities

A collaboration endpoint must be able to:

- attach to a collaboration scope
- receive directed work
- produce structured results
- report health
- report capabilities
- participate in lifecycle changes such as detach or degraded operation

### Rationale

This is more future-proof than modeling every host as an interactive text terminal. It allows future providers to represent:

- terminal-based tools
- daemon-backed agents
- API-backed local agents
- other endpoint styles that still satisfy the collaboration contract

## Provider Extensibility Strategy

`ai-whisper` v1 should use a hybrid extensibility model.

### v1 behavior

- built-in provider registry is shipped with the product
- external provider registration points exist conceptually, but external providers are not the main delivery goal for v1

### Design rule

The contract must be stable enough that future providers can target it without forcing a redesign of the broker or companion layers.

### Rationale

This keeps v1 implementation realistic while preventing the architecture from becoming permanently closed to other AI tools.

## Shared Provider Contract Surface

The shared provider contract should be medium-sized.

### Required conceptual operations

- attach or bind to a collaboration context
- accept directed work delivery
- return structured results
- report health
- report baseline capabilities
- emit structured capability updates
- support lifecycle hooks such as detach
- expose normalization behavior when direct packet output is not possible

### Why medium-sized

The contract must be rich enough to support:

- long-lived session collaboration
- capability negotiation
- normalization fallback
- health and degraded state handling

It should not absorb unrelated admin or broker responsibilities.

## Launch Responsibilities

Launch behavior should be optional in the shared contract.

### Design rule

- provider launch hooks may exist
- launch must not be required for a provider to be valid

### Rationale

Some providers may be able to launch their host environment directly, while others may only support attach or bind after the host already exists.

This keeps launch orchestration in the appropriate layer while still allowing providers to contribute launch-specific behavior when useful.

## Normalization Model

The provider contract should prefer direct broker-valid packet output, with explicit normalization as a fallback path.

### Preferred path

- provider emits a broker-valid handoff or reply packet directly

### Fallback path

- provider emits a host-native result
- provider normalization hook converts it into a broker-valid packet

### Design rule

Normalization should be explicit in the contract, not hidden as an informal provider behavior.

### Rationale

This supports strong validation and consistent broker semantics while accommodating tools that cannot always produce broker-native packets directly.

## Relay Interception

Relay interception should exist as a shared capability in the provider contract.

### Design rule

- the core contract recognizes relay interception as a capability
- each provider decides how that capability is implemented internally

### Example relay directives

- `@@codex review this plan`
- `@@claude implement phase 1`

### Rationale

The collaboration model needs a common concept of relay interception, but the mechanism for observing and transforming host-session input will vary across providers.

## Capability Model

Provider capabilities should support both stable baseline negotiation and runtime change.

### Attach-time baseline

At attach time, the provider declares a baseline capability set.

Example capability areas:

- direct broker-valid packet support
- normalization support
- relay interception support
- local buffering support
- launch hook support

### Runtime updates

After attach, the provider may emit structured capability updates when the effective operational state changes.

Examples:

- direct packet mode temporarily unavailable
- host responsiveness degraded
- fallback normalization mode active

### Rationale

This preserves a strong baseline contract while allowing long-lived sessions to degrade and recover honestly over time.

## Namespaced Optional Extensions

The shared contract should allow tool-specific or provider-specific optional extensions through namespaced capability bags.

### Design rule

The core contract must not require every provider to implement every special feature.

Instead:

- common behavior stays in the shared contract
- provider-specific features are exposed through explicit namespaced extensions

### Example extension naming style

- `openai.codex.*`
- `anthropic.claude_code.*`
- `custom.provider_x.*`

### Rationale

This keeps the core contract stable while allowing provider-specific evolution without polluting the generic endpoint model.

## Discovery Model

Provider discovery should use a hybrid strategy.

### Required behavior

- built-in providers are registered in a static internal registry
- the architecture must allow optional external provider registration points later

### Rationale

This keeps v1 implementation controlled while preserving the ability to experiment with future AI agents beyond Codex and Claude.

## Responsibility Boundaries

### Core system responsibilities

- define the shared provider contract
- manage provider selection and routing
- remain agnostic to provider-specific mechanics

### Provider responsibilities

- satisfy the shared collaboration endpoint contract
- implement host-specific attach, delivery, and result behavior
- expose health, capabilities, and normalization behavior honestly
- optionally contribute launch hooks

### Provider-specific extension responsibilities

- expose extra features through explicit namespaced extension areas
- avoid leaking provider-specific behavior into the shared contract unless it becomes common enough to standardize

## Constraints and Non-Goals

This design intentionally does not define:

- final TypeScript interface signatures
- exact provider packaging layout
- exact provider discovery file format
- exact extension payload schemas
- exact launch hook semantics

Those belong in the next technical and implementation-planning layers.

## Recommended Next Step

This was the last major architecture boundary that materially affects implementation planning.

The next step should be to stop design expansion and write the implementation plan that maps:

- packages
- provider interfaces
- broker operations
- CLI flows
- persistence
- tests

into an executable task sequence.
