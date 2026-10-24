# Autonomous Company — Supporting Infra Concepts

Part 3 of 4. See also:
- [Roles & functions](2026-04-19-global-autonomous-company-roles.md)
- [Plugin primitive design](2026-04-19-global-autonomous-company-primitive.md)
- [Roadmap](2026-04-19-global-autonomous-company-roadmap.md)

## Context

The plugin primitive (part 2) lets each function declare its UI + agent surface + event log. But a running company needs more than isolated plugins — it needs a shared substrate they all sit on: memory they share, trust rules they respect, budgets they honor, handoffs between them.

This doc names the concepts that substrate must provide. Each is described at the level of *what it is and why it matters*; concrete implementation form (storage choice, API shape, transport) is deliberately deferred. The goal is to make sure we name every concept up front so the primitive and the roadmap can account for them.

## Concepts

Each concept gets:
- **What it is** — one-line description
- **Why it matters** — what breaks without it
- **Where it sits** — roughly whose problem it is (plugin-core, server core, per-plugin, cross-cutting)

---

### 1. Institutional memory

**What it is.** A living knowledge layer holding brand voice, pricing, positioning, product policy, current priorities, internal conventions. Agents read from it when producing anything outward-facing; they can propose updates to it.

**Why it matters.** Without a shared source, every agent reinvents the company's voice and rules. Consistency dies; policy drift happens silently; new agent roles can't onboard.

**Where it sits.** Cross-cutting, server-owned. Read by all plugins. Writes gated by a trust envelope (updates `review` by default).

**Not to be confused with.** Auto-memory (the Claude Code user-facing memory system) — that's per-user, about the person. Institutional memory is per-company, about the org.

---

### 2. Event log & replay

**What it is.** A single ordered log of every event in a workspace — tool calls, UI interactions, triggers, human edits. Replayable, scrubable, forkable.

**Why it matters.** Debugging autonomous agents without full event history is impossible. "Why did the agent do this" becomes "look at the log." Also: enables teaching agents from past runs, generating training data, rolling back state.

**Where it sits.** Plugin-core primitive (part 2 requires it). Server persists it. UI surfaces it as a replay view.

---

### 3. Trust / permission envelopes

**What it is.** The metadata on each command — `auto` / `review` / `approve` — plus the machinery that enforces it, promotes it, and surfaces blocked actions to humans.

**Why it matters.** This is the single biggest control surface for safety. Without it, the system is either fully manual (slow) or fully autonomous (risky). With it, each command rides its own promotion gradient.

**Where it sits.** Primitive declares the envelope per command; server enforces it; a dedicated **exception surface** (see #9) shows pending approvals.

---

### 4. Secrets & credential scoping

**What it is.** Per-plugin credential storage with scoped API keys: the support plugin gets a Zendesk token, the billing plugin gets a Stripe key, neither sees the other's.

**Why it matters.** A plugin compromise (prompt injection, bad agent) must not cascade. Credential isolation is the firebreak.

**Where it sits.** Server-core, plugin-namespaced. Retrieval goes through a scoped accessor, never raw env vars. Rotations are their own commands with their own trust envelopes.

---

### 5. Cost governance

**What it is.** Per-plugin and per-agent budgets for LLM spend, external-service spend, infra spend. Real-time tracking, soft alerts, hard caps.

**Why it matters.** Autonomous agents will spend money. A runaway loop or a bad prompt can burn budget in minutes. Without caps, the first outage is always financial.

**Where it sits.** Server-core cross-cutting service. Every command's trust envelope can carry a cost-impact tag. A FinOps role (part 1) reports on the aggregate.

---

### 6. Trigger / scheduler system

**What it is.** The infra that receives inbound events (webhooks, emails, cron ticks, metric alerts) and dispatches them into the right plugin scope as an agent session.

**Why it matters.** Without it, everything is polling or manual. With it, agents become ambient — reacting to the world as events happen.

**Where it sits.** Server-core. Declared by plugins (part 2 specifies the `onEvent` primitive), implemented centrally so cross-plugin scheduling and rate limiting work.

---

### 7. Inter-agent messaging & handoff

**What it is.** The protocol by which one agent calls another — not via low-level command invocation, but as a first-class handoff with context. Example: support agent escalates to engineering agent, with the ticket context attached.

**Why it matters.** In a company, work crosses functional lines constantly. Without a handoff primitive, each plugin has to reinvent this, and traces get fragmented across workspaces.

**Where it sits.** Plugin-core primitive (related to but distinct from commands and triggers). Shared event log means the receiving agent inherits provenance for free.

---

### 8. Agent evaluation & quality scoring

**What it is.** A framework that measures each agent role's output quality over time: outcome metrics (ticket resolution time, marketing CTR, bug recurrence), human edit rates, escalation rates, cost-per-outcome.

**Why it matters.** Agent HR (part 1) needs data. Trust envelope promotions (part 2) need data. Without evaluation, you can't tell a good agent from a lucky one, and you can't retire a bad one.

**Where it sits.** Cross-cutting service consuming the event log. Exposes a dashboard (part 1 Analytics/BI) and an API agents use to self-assess.

---

### 9. Exception surface (single human pane)

**What it is.** One dashboard showing everything that needs human attention *right now*: pending approvals, flagged actions, anomalies, escalations. Exception-based, not polling-based.

**Why it matters.** "Minimal supervision" is only real if humans don't have to scan dozens of plugins to find what needs them. If the system can't surface exceptions in one place, the human becomes the polling loop.

**Where it sits.** A dedicated plugin (maybe the shell's job, maybe its own) that reads from trust-envelope queues, triggers, and anomaly detectors across the company.

---

### 10. Rollback & kill switches

**What it is.** Per-plugin and global "stop" mechanisms: pause a plugin, revert its last N events, kill all agent sessions, freeze outward-facing actions.

**Why it matters.** When something goes wrong, the first response must be "make it stop" — not "figure out which service to restart." Agents operating autonomously will sometimes produce bad outcomes; containment is a feature.

**Where it sits.** Server-core control plane. Surfaced on the exception dashboard. Paired with the event log (#2) so "stop + rewind" is a single action.

---

### 11. Multi-tenancy / namespace isolation

**What it is.** If equin ever hosts more than one company, or more than one environment (staging vs. prod), the substrate needs strict namespace boundaries: separate memory, credentials, event logs, budgets.

**Why it matters.** Cross-tenant leaks are catastrophic. Even for single-tenant, staging/prod separation matters for testing new agent roles safely.

**Where it sits.** Server-core, touching every concept above. For the initial single-tenant case, this is effectively "namespace = worktree" and piggybacks on the existing gateway model.

---

### 12. Observability for the agent itself

**What it is.** Agents can query their own recent actions, outcomes, and trust state. Self-reflection and self-correction loops.

**Why it matters.** The best quality gate is an agent noticing it's about to make the same mistake twice. Without introspection, every agent starts cold.

**Where it sits.** A thin read-only interface over the event log (#2) and evaluation scores (#8), exposed as a narrative + tool to agents.

---

## How the concepts relate

```
                            ┌──────────────────────────┐
                            │  Plugin Primitive (p2)   │
                            │  scopes, commands,       │
                            │  triggers, narrative     │
                            └────────────┬─────────────┘
                                         │
         ┌───────────────────────────────┼────────────────────────────────┐
         │                               │                                │
 ┌───────▼─────────┐           ┌─────────▼─────────┐           ┌──────────▼──────┐
 │ Institutional   │           │  Event log (2)    │           │ Trust envelopes │
 │   memory (1)    │◄─write────┤  shared state     ├──feeds───►│      (3)        │
 └─────────────────┘           └─────────┬─────────┘           └──────────┬──────┘
                                         │                                │
                  ┌──────────────────────┼──────────────────┐             │
                  │                      │                  │             │
           ┌──────▼──────┐       ┌───────▼───────┐  ┌──────▼──────┐      │
           │ Triggers(6) │       │  Handoffs(7)  │  │  Eval (8)   │      │
           └─────────────┘       └───────────────┘  └──────┬──────┘      │
                                                           │             │
                                                    ┌──────▼─────────────▼──────┐
                                                    │  Exception surface (9)    │
                                                    │  + kill switches (10)     │
                                                    └───────────────────────────┘

    Cross-cutting: Secrets (4), Cost (5), Multi-tenancy (11), Self-observability (12)
```

## What this does not specify

- The concrete **storage** for any of these (Postgres? KV? Files?)
- The **API shape** for how plugins consume them
- The **transport** (sync vs async, push vs pull)
- Whether they are one service or many

Those choices come when each concept is designed in its own research doc, driven by the needs of the first real plugin that uses it. The purpose of this doc is to make sure nothing is forgotten — so when we reach for a concept in part 4's roadmap, the concept is already on the map.

## Minimum viable subset

For Phase 0–2 of the roadmap (the self-improving coding studio + primitive + observation foundation), we need:

- **Event log (2)** — the primitive depends on it
- **Trust envelopes (3)** — even for coding tasks, `review` vs `auto` matters
- **Exception surface (9)** — even minimally, humans need one place to look
- **Rollback (10)** — essential before any autonomous action ships

Everything else is deferred until the corresponding roles come online in Phases 3+.
