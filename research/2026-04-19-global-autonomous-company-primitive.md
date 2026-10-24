# Autonomous Company — Plugin Primitive ("React-for-Agents")

Part 2 of 4. See also:
- [Roles & functions](2026-04-19-global-autonomous-company-roles.md)
- [Supporting infra concepts](2026-04-19-global-autonomous-company-infra.md)
- [Roadmap](2026-04-19-global-autonomous-company-roadmap.md)

## Context

equin's plugin system today has three primitives: **slots** (typed extension points), **commands** (request-response actions between plugins), and **resources** (live state synced via a single WS). These cover the human-facing app well.

For an autonomous company, every plugin must expose two symmetric surfaces:
- A **UI surface** — how humans monitor and intervene
- An **agent surface** — how agents read and act on the same domain

MCP, Skills, and CLI each capture one dimension but miss the others:
- **MCP** gives typed tools but flat namespace, no narrative, no shared UI state
- **Skills** give narrative/examples but no typed actions, no UI
- **CLI** is universal but opaque to the UI and has no schema

The missing primitive is **shared state between UI and agent surface** — so both projections come from one declaration, with real-time coupling. This doc sketches what that primitive needs to express, without committing to a concrete implementation form.

## Guiding principle

> A plugin declares a *workspace*. The UI and the agent are two projections of the same workspace state. Every event — whether from a click, a trigger, an agent tool call, or a human edit — flows through the same log. Humans and agents see, change, and learn from the same substrate.

This is the "React-for-agents" idea: unify UI and agent capability from one source, the way React unified markup and behavior.

## What the primitive must express

Six concerns. The plugin system today covers (1) partially and (2) barely; the rest are net-new.

### 1. Typed commands with dual projection

A command declares a typed operation. It auto-projects as:
- A **UI affordance** — button, form, menu item, drag handler, etc.
- An **agent tool** — callable with a derived schema
- A **server handler** — one implementation, one source of truth

Today, UI actions and server routes are declared separately; agents have no first-class access to either. The primitive should collapse these into one declaration.

### 2. Scopes (contextual surfaces)

Tools should not be globally visible to agents. At any moment, the agent is *in* a scope (a workspace, a page, a sub-pane) — only that scope's commands and narrative are in context.

- Entering `/support/ticket/42` makes ticket-scoped commands visible and loads ticket-scoped narrative.
- Exiting the scope releases them.
- Scopes nest: `/support` tools are also visible inside `/support/ticket/42`.
- Agents navigate scopes the same way humans do (URL / pane focus). Scope is state, not config.

This keeps tool lists small, legible, and matched to the current task. It also mirrors how a human operator narrows attention.

### 3. Narrative baked in

Each command, and each scope, ships with skill-style prose:
- When to use it
- When *not* to use it
- Examples and anti-patterns
- Pre/post-conditions the agent should verify

Loaded into the agent's context only when the scope is entered. This is what Skills does globally; here it's scoped and attached to typed actions.

### 4. Triggers symmetric with commands

In a company, most agent work is event-driven: a ticket arrives, a webhook fires, a cron elapses, a metric breaches. The primitive must treat `onEvent` as a first-class sibling of `onClick`.

- Plugins declare triggers the same way they declare commands.
- Each trigger spawns a scoped agent session in the appropriate workspace.
- The trigger's payload is the initial context; the scope's narrative guides the work.
- Humans see triggers fire in the UI; the agent's response is observable in real time.

Without this, agents are reactive to humans only. With it, agents are reactive to the world.

### 5. Trust envelopes per command

Each command declares a policy: `auto`, `review`, or `approve`. The policy is tunable per-scope (tier-1 support ticket auto-sends; enterprise ticket requires approval).

- `auto` — command executes directly when invoked by an agent
- `review` — executes, but the result is surfaced as reviewable; humans can edit/revert before finalization
- `approve` — blocks until a human explicitly approves

Policies promote over time (see Agent HR in part 1). This is the primary knob for blast-radius control.

### 6. Live shared state — events, not commands

All actions — agent tool calls, UI interactions, triggers, human edits to drafts — land in one ordered event log per workspace. The primitive is event-sourced from the start:

- Agent calls a command → event emitted → UI updates → event logged
- Human edits a draft → event emitted → agent observes the edit → event logged
- Trigger fires → event emitted → agent session spawns → event logged

This gives replay, audit, and reverse projection (humans teaching agents via normal UI use) for free. It is *the* feature that differentiates this primitive from MCP + Skills stitched together.

## How it extends existing plugin-core

Current primitives remain the foundation:
- **Slots** still define UI extension points
- **Commands** (the existing imperative ones) become a subset of typed commands — now with agent-side projection
- **Resources** become one kind of scope-bound shared state

New concepts to introduce:
- **Scope** — a named context with a URL, a narrative bundle, a set of visible commands, and a bound event log
- **Trigger** — a declared inbound event that instantiates an agent session in a scope
- **TrustEnvelope** — metadata on each command, tunable per scope
- **NarrativeBundle** — the prose attached to a scope or command
- **EventLog** — the scoped ordered event stream

Concrete form of each — API shape, storage, transport — is deliberately out of scope here. This doc specifies the semantic obligations; part 3 names the infra concepts; the actual design will be iterated as a follow-up research doc (likely `2026-0X-XX-plugin-core-agent-primitive.md` once a concrete sketch is ready).

## Non-goals (for this primitive spec)

- **Multi-agent orchestration** — how agents call each other (handoffs) lives in the infra layer (part 3), not in the plugin primitive.
- **Institutional memory** — brand voice, pricing policy, etc., is a cross-cutting concern (part 3), not per-plugin state.
- **Agent runtime choice** — Claude, Agent SDK, local models, etc. — the primitive should be agnostic. Runtime choice belongs to conversations/agents plugins as today.

## Open questions

1. **Where does the narrative live?** Inline in the plugin code (like JSDoc), in a sibling markdown file, or in a queryable store that agents browse? The first is easiest; the third scales better.
2. **Is scope explicit or implicit?** Explicit (`enterScope(id)`) is legible but ceremonious; implicit (scope = current URL + focused pane) is frictionless but less controllable.
3. **How granular is the event log?** Per-plugin, per-scope, per-conversation, or global? Too granular makes cross-plugin reasoning hard; too coarse makes replay noisy.
4. **How do trust envelopes promote?** Manual human flip, automatic after N successful reviews, tied to agent-HR evaluations? Probably all three, but the default matters.
5. **Can agents define new scopes dynamically?** If yes, the agent-recruiting role (part 1) becomes much more powerful. If no, scopes stay static/human-defined. The former unlocks more; the latter is safer.

## Why this matters

Every subsequent role in part 1 lands on top of this primitive. A support plugin without scoped narrative produces generic replies. A marketing plugin without trust envelopes either posts slop or never posts at all. A billing plugin without a shared event log can't be audited.

The primitive is the single biggest leverage point between "coding-agent manager" and "autonomous company." Everything downstream is either a plugin built on it, an infra concept that serves it (part 3), or a roadmap phase that sequences its adoption (part 4).

## Critical existing files this extends

- `plugin-core/slots.ts` — adds scope-aware slot resolution
- `plugin-core/commands.ts` — extends command metadata with trust envelope, narrative, agent-projection schema
- `plugin-core/context.tsx` — scope tracking and propagation
- New: `plugin-core/scope.ts`, `plugin-core/trigger.ts`, `plugin-core/narrative.ts` (names TBD)
- Server-side twin for each (trigger receipt, event log, scope resolution)

These are sketches, not commitments. The actual surgery on `plugin-core` will be designed in its own research doc once the primitive shape is validated via a couple of concrete plugins (likely support and docs, the two lowest-risk functions from part 1).
