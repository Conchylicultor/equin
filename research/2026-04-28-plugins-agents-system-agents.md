---
name: System Agents in the Agents pane
description: Add a registration mechanism for plugin-contributed "System" agents (e.g. summary) and let each one render a custom detail view.
---

# System Agents in the Agents pane

## Context

Today the Agents pane (`plugins/agents/`) shows only **user-created** agents stored as rows in `_agents`. Other plugins already run agent-like flows behind their own UIs — the canonical example is `summary` (`plugins/conversations/plugins/summary/`), which spawns a `kind: "system"` Sonnet conversation with a hard-coded prompt in `prompt.ts:74` to summarize a target conversation. Users have no way to inspect or customize that prompt.

We want a single home for these "system agents" inside the Agents pane so users can:

- Discover what agents the app runs in the background.
- Customize their prompts/models (where each plugin chooses to expose this).
- Optionally see a richer per-agent UI than the default editor (e.g. summary needs a target-conversation picker, not a generic Launch button).

This is **infra-only** — the existing `summary` plugin is **not** migrated in this change (per Q3 answer). Migration lands as a follow-up so the abstraction can be reviewed in isolation.

## Design at a glance

System agents are **code descriptors**, not DB rows. Each owning plugin decides where to persist editable values (often `@plugins/config`, sometimes a small private table). This mirrors the `defineAuthProvider` pattern (`plugins/auth/shared/internal/lib.ts:67`).

One new slot on `Agents`:

- `Agents.SystemAgent` — descriptor registry. The descriptor carries an optional `component` field that, when present, renders as the agent's detail body. When absent, a minimal fallback view renders the descriptor's name/description plus a note that the owning plugin hasn't shipped a UI. The list uses the same registry to render a virtual **"System" folder** at the top of the tree (hidden when empty).

The descriptor and its detail component are 1:1 (the plugin that registers the agent is the same one that knows how to render it), so they belong on the same contribution rather than in two slots wired together by a predicate. The `file-pane` predicate/resolver pattern (`plugins/conversations/plugins/conversation-view/plugins/code/plugins/file-pane/web/slots.ts:5`) is the right shape when **multiple** contributors compete for the same target (image vs. raw vs. markdown, ranked by `supports()`); that's not the case here.

A new pane `systemAgentDetailPane` at `/agents/system/:systemId` handles selection of a system agent. The list renders descriptors as siblings of user folders but routes them through this pane instead of `agentDetailPane`. The user-agent detail flow (`agentDetailPane`) is **untouched** in this PR — if we ever want to override user-agent detail views, that's a separate slot added when the use case appears.

## API shape

### `defineSystemAgent` helper

```ts
// plugins/agents/web/system-agents.ts (new)
export interface SystemAgentDescriptor {
  id: string;                  // /^[a-z][a-z0-9-]*$/, unique across plugins
  name: string;
  description?: string;
  icon?: ComponentType;        // optional row icon; default falls back to Bot
  component?: ComponentType<{ descriptor: SystemAgentDescriptor }>; // optional custom detail body
}

export function defineSystemAgent(d: SystemAgentDescriptor): SystemAgentDescriptor {
  if (!/^[a-z][a-z0-9-]*$/.test(d.id)) throw new Error(`defineSystemAgent("${d.id}"): invalid id`);
  return d;
}
```

### Slot

```ts
// plugins/agents/web/slots.ts (extend)
import type { SystemAgentDescriptor } from "./system-agents";

export const Agents = {
  // existing
  List: defineSlot<{ id: string; component: ComponentType }>("agents.list"),
  View: defineSlot<{ id: string; title?: string; component: ComponentType<{ agentId: string }> }>("agents.view"),
  AgentActions: defineSlot<{ id: string; component: ComponentType<{ agentId: string }> }>("agents.agent-actions"),

  // new
  SystemAgent: defineSlot<SystemAgentDescriptor>("agents.system-agent"),
};
```

### Consumer example (sketch — not landed in this PR)

```ts
// plugins/conversations/plugins/summary/web/index.ts (future)
export default {
  id: "...",
  contributions: [
    Agents.SystemAgent(defineSystemAgent({
      id: "summary",
      name: "Summarise",
      description: "Generates a structured summary of a conversation.",
      component: SummaryAgentDetail, // owns prompt-edit UI + target-convo picker
    })),
  ],
};
```

## Files to add

- `plugins/agents/web/system-agents.ts` — `defineSystemAgent` + `SystemAgentDescriptor`.
- `plugins/agents/web/components/system-agent-detail.tsx` — fallback detail body when the descriptor has no `component`.
- `plugins/agents/web/components/system-folder.tsx` — virtual "System" folder rendered above the user tree (collapsible via local state, no DB row).

## Files to modify

- `plugins/agents/web/slots.ts` — add `SystemAgent` slot.
- `plugins/agents/web/index.ts` — re-export `defineSystemAgent`, `SystemAgentDescriptor`, plus the new pane.
- `plugins/agents/web/panes.tsx`:
  - Add `systemAgentDetailPane` under `agentsRootPane` at `system/:systemId`. Resolve descriptor from `Agents.SystemAgent.useContributions()`; 404 fallback if missing. Render `descriptor.component ?? SystemAgentDetail`.
  - `agentDetailPane` (user agents) is **untouched**.
- `plugins/agents/web/components/agents-list.tsx` — render `<SystemFolder/>` above the existing user tree when `Agents.SystemAgent.useContributions().length > 0`. System rows route via `systemAgentDetailPane.open({ systemId })`.

## URL routing

- `/agents` — list (unchanged).
- `/agents/:id` — user agent detail (unchanged).
- `/agents/system/:systemId` — system agent detail (new).

The two detail panes are siblings under `agentsRootPane`, matching the existing `agentDetailPane` shape (`panes.tsx:23`). No conflict with the existing `:id` route since `system` is a literal segment that wins over the param via `matchRegistry` longest-prefix logic (`plugins/primitives/plugins/pane/web/pane.ts:128`).

## Non-goals / explicit follow-ups

- **No summary migration.** Summary still launches via its own `/api/conversation-summary/:id/generate` route. Migration PR will register an `Agents.SystemAgent` contribution (with a custom `component`) and move the prompt into config.
- **No server-side registry.** System agents are web-only descriptors in v1. If the server later needs to enumerate them (e.g. to gate launches), we add a parallel registry then.
- **No bundled "Launch" semantics for system agents.** Many parameterized agents (summary, future per-conversation tools) don't fit a fire-and-forget Launch. The default fallback view is intentionally minimal — owning plugins are expected to ship a `DetailView`.
- **No new DB columns or migrations.** `_agents` is unchanged.

## Verification

1. `./equin build` from this worktree; open `http://<worktree>.localhost:9000/agents`.
2. With no consumers wired up: System folder is **not** rendered. User-agent flow is unchanged (create/edit/launch still works at `/agents/:id`).
3. Land a temporary throwaway contribution in the dev branch (or a tiny test plugin under `plugins/agents/plugins/_demo/`) that calls `Agents.SystemAgent(defineSystemAgent({...}))` with a fake descriptor:
   - With `component`: system folder appears above user tree, collapsible. Clicking the row navigates to `/agents/system/<id>` and renders the stub component.
   - Without `component`: same row renders the fallback `<SystemAgentDetail/>`. Remove before merging.
4. `./equin check` passes (plugin boundaries, migrations-in-sync — should be a no-op since no schema change).

## Critical files referenced

- `plugins/agents/web/slots.ts:4` — existing slot definitions.
- `plugins/agents/web/panes.tsx:15` — pane hierarchy and `AgentDetailBody`.
- `plugins/agents/web/components/agent-detail.tsx:32` — current default detail body.
- `plugins/agents/web/components/agents-list.tsx` — tree renderer.
- `plugins/auth/shared/internal/lib.ts:67` — `defineAuthProvider` pattern (mirror).
- `plugin-core/slots.ts:12` — `defineSlot` primitive.
- `plugins/primitives/plugins/pane/web/pane.ts:414` — `Pane.define` API used for the new `systemAgentDetailPane`.
