# Decompose the `conversations` live resource into keyed delta-sync sub-resources

## Context

The `conversations` live-state resource (`conversationsLiveResource`) returns an
**aggregate payload** — `{ active, recentGone, hasMoreGone, totalGoneCount, system }`
— and is declared `mode: "push"`. A push resource re-serializes and re-ships its
**entire payload** to **every subscriber** on **any single** conversation change.
On a busy machine the active list can hold dozens of conversation rows, and the
poller mutates conversation rows many times per second, so every tab repeatedly
receives the whole list even when one row's `status` flipped.

The scoped-recompute work (`research/2026-06-20-global-scoped-recompute-default.md`)
already made the *downstream* cascade (`attempts → tasks`) scoped via the
`identityTable` + `affectedMap` edges, but it did **not** shrink this resource's
*own wire payload* — `mode: "push"` always re-ships whole.

**Goal / intended outcome:** decompose the aggregate into **keyed array
sub-resources** that delta-sync (ship only the changed row + new order), plus one
tiny scalar resource for the gone count, recombined client-side via
`useCombinedResources`. After this change, a single conversation status change
ships **one keyed-delta upsert** on `conversations-active`, not the whole list —
while every consumer keeps reading the same logical data through the existing
`use-conversations.ts` hook boundary.

This is the follow-up explicitly noted in §4 of the scoped-recompute research doc.

## Design overview

Split the one push resource into **four** resources:

| New resource | Mode / scope | Replaces field(s) |
|---|---|---|
| `conversations-active` | keyed, `identityTable: "conversations"`, `debounceMs: 250` | `active` |
| `conversations-system` | keyed, `identityTable: "conversations"` | `system` |
| `conversations-gone` | keyed, `recompute: { kind: "full", reason }` | `recentGone` |
| `conversations-gone-stats` | push, `{ totalGoneCount }` | `totalGoneCount` (+ derived `hasMoreGone`) |

Key facts that make this correct:

- **Keyed resources read like push resources.** `useResource` on a
  `keyedResourceDescriptor` returns the merged `T[]`; the delta-merge is invisible
  to consumers. Same pattern already used by `tasksResource` / `attemptsResource`
  in this very plugin.
- **`hasMoreGone` is derivable.** Today `hasMoreGone = goneRows.length > 30` where
  `goneRows = listGoneConversations({limit:31})`. `countGoneConversations()` uses
  the *same* filter, so `length > 30 ⟺ count > 30`. The client derives
  `hasMoreGone = totalGoneCount > RECENT_GONE_LIMIT` — equivalent, and lets us drop
  the `+1` query.
- **The gone window must be FULL-recompute.** It is a bounded window ordered by
  `endedAt DESC LIMIT 30`: one conversation ending changes window *membership* (a
  row enters, the oldest may drop). A per-id scoped recompute can't express that,
  so it declares the explicit `recompute: { kind: "full", reason }` opt-out (the
  `keyed-resource-scope` check requires keyed resources to declare
  `identityTable` XOR `recompute`).

### The cascade rewiring (the load-bearing detail)

`attemptsResource.dependsOn` currently targets `conversationsLiveResource` to
convert changed conv-ids → scoped attempt recomputes. After the split it targets
**`conversationsActiveResource` alone**, and this is provably sufficient:

1. **The L4 feed delivers EVERY `conversations` row change to
   `conversationsActiveResource`, scoped to its id** — because read-sets are
   *table-level*. `listActiveConversations()` does `db.select().from(conversations)`,
   so its read-set covers the whole `conversations` table; `applyDbChange`
   (`resource-runtime/core/runtime.ts` ~L1686, L1705-1723) matches any
   `conversations` UPDATE and, since `origin === identityTable === "conversations"`,
   delivers it **scoped** — even for a gone-only row that the `WHERE active=true`
   filter excludes from the result.
2. **The downstream `affectedMap` edge fires on the DELIVERED affected set, not on
   payload change.** In `drainEntry` the only early-out is the empty-scoped-set
   guard (`runtime.ts` ~L1200-1201); the downstream loop (~L1319-1356) calls
   `edge.affectedMap(affected, params)` unconditionally, independent of whether the
   keyed diff produced any upserts. So even a gone-only conversation change
   propagates its conv-id to `attempts` (scoped, never FULL).

The `affectedMap` body is byte-identical (it self-queries `conversations` by id;
it never reads the upstream value). `tasksResource` is unchanged (depends on
`attemptsResource`, covered transitively).

**`debounceMs: 250`** (the cascade-source trailing debounce that collapses a
poller tick's status churn) moves onto `conversationsActiveResource` — it is the
resource carrying the attempts cascade and the poller's status writes. `gone` /
`gone-stats` / `system` need no debounce.

## Implementation steps

### 1. Core descriptors — `plugins/tasks/plugins/tasks-core/core/`

**`core/resources.ts`** — add four descriptors (mirror `tasksResource` /
`attemptsResource` exactly). `ConversationSchema` / `Conversation` import from
`../server/internal/schema` (already the source `schemas.ts` uses):

```ts
export const conversationsActiveResource = keyedResourceDescriptor<Conversation[]>(
  "conversations-active", z.array(ConversationSchema), [], (r) => (r as Conversation).id,
);
export const conversationsSystemResource = keyedResourceDescriptor<Conversation[]>(
  "conversations-system", z.array(ConversationSchema), [], (r) => (r as Conversation).id,
);
export const conversationsGoneResource = keyedResourceDescriptor<Conversation[]>(
  "conversations-gone", z.array(ConversationSchema), [], (r) => (r as Conversation).id,
);
export const conversationsGoneStatsResource = resourceDescriptor<{ totalGoneCount: number }>(
  "conversations-gone-stats", z.object({ totalGoneCount: z.number() }), { totalGoneCount: 0 },
);
```

Also add `export const RECENT_GONE_LIMIT = 30;` to `core` (so the web can derive
`hasMoreGone`). `RECENT_GONE_LIMIT` currently lives in
`server/internal/queries/conversations.ts:7` — move it to core and have the
queries file import it back (`import { RECENT_GONE_LIMIT } from "../../../core"`;
core has no server deps, so this direction forms no cycle).

**`core/schemas.ts`** — remove `ConversationListPayloadSchema`,
`ConversationListPayload`, and `conversationsResource` (lines 20-33). Nothing reads
the aggregate after the rewrite.

**`core/index.ts`** — drop the `conversationsResource` / `ConversationListPayload`
exports; add the four new descriptors + `RECENT_GONE_LIMIT`.

### 2. Server resources — `plugins/tasks/plugins/tasks-core/server/internal/resources.ts`

Replace the `conversationsLiveResource` block (lines 31-60) with four
`defineResource(descriptor, …)` calls, **defined before `attemptsResource`** (the
runtime wires a downstream edge only if the upstream entry already exists).

```ts
export const conversationsActiveResource = defineResource(conversationsActiveDescriptor, {
  // Loader reads the whole `conversations` table, so the L4 feed delivers EVERY
  // conversation UPDATE here scoped to its id — which is why attempts can cascade
  // off this one sub-resource alone (the delivered affected set drives the edge
  // regardless of whether this active-filtered payload changed).
  identityTable: "conversations",
  debounceMs: 250, // cascade source — collapses a poller tick. Source-only.
  loader: async (_p, ctx): Promise<Conversation[]> =>
    listActiveConversations(ctx?.affectedIds),
});

export const conversationsSystemResource = defineResource(conversationsSystemDescriptor, {
  identityTable: "conversations",
  loader: async (_p, ctx): Promise<Conversation[]> =>
    listActiveSystemConversations(ctx?.affectedIds),
});

export const conversationsGoneResource = defineResource(conversationsGoneDescriptor, {
  recompute: { kind: "full", reason:
    "bounded recent-gone window ordered by endedAt; one conversation ending changes window membership" },
  loader: async (): Promise<Conversation[]> =>
    listGoneConversations({ limit: RECENT_GONE_LIMIT }),
});

export const conversationsGoneStatsResource = defineResource(conversationsGoneStatsDescriptor, {
  mode: "push",
  loader: async () => ({ totalGoneCount: await countGoneConversations() }),
});
```

**Scoped loaders for active/system** — add a `convIds?: readonly string[]` filter
to `queries/conversations.ts` (mirrors the existing `taskIds` / `attemptIds`
precedent) so the keyed scoped recompute is a real `WHERE id IN (…)` rather than
an in-memory filter:

```ts
// Filters type:  convIds?: readonly string[];
// buildWhere:    if (f.convIds) clauses.push(inArray(conversations.id, [...f.convIds]));
export function listActiveConversations(convIds?: readonly string[]): Promise<Conversation[]> {
  return queryConversations({ active: true, convIds }, { col: conversations.createdAt, dir: "desc" });
}
export function listActiveSystemConversations(convIds?: readonly string[]): Promise<Conversation[]> {
  return queryConversations({ onlySystem: true, active: true, convIds }, { col: conversations.createdAt, dir: "desc" });
}
```

**`attemptsResource.dependsOn`** (lines 72-86) — change `resource:
conversationsLiveResource` → `resource: conversationsActiveResource`. `affectedMap`
body unchanged. Add a one-line comment that this relies on the active loader's
read-set covering the whole `conversations` table.

### 3. Registration — `plugins/tasks/plugins/tasks-core/server/index.ts`

Drop `conversationsLiveResource` from imports / re-exports / the
`Resource.Declare(conversationsLiveResource, { bootCritical: true })` (line ~175).
Add four `Resource.Declare(<each>, { bootCritical: true })`. Keep the existing
`View({ view: conversations, identityTable: "conversations" })`. Add the four new
server resources to the server barrel re-export list.

### 4. Hook boundary — `plugins/conversations/web/use-conversations.ts`

Rewrite to source the four resources; preserve the public `ConversationsState`
contract and per-id `select` re-render isolation. Drop the
`conversationsResource` / `ConversationListPayload` imports; add the four
descriptors + `RECENT_GONE_LIMIT`.

- **`useConversations()`** — `useResource` each of the four, gate with
  `useCombinedResources({ active, system, gone, stats })`, return
  `{ active, recentGone: gone, system, totalGoneCount: stats.totalGoneCount,
  hasMoreGone: stats.totalGoneCount > RECENT_GONE_LIMIT }`.
- **`useConversation(id)`** — three independent `useResource(<res>, undefined,
  { select: rows => rows.find(x=>x.id===id) ?? null })` calls over
  active / gone / system; first non-null wins (preserves active→recentGone→system
  priority). **Strictly better isolation than today** — a status flip on an active
  row no longer touches the gone/system subscriptions.
- **`useHasActiveSiblings` / `useHasActiveSiblingInWorktree`** — point the existing
  `select` (over the active list) at `conversationsActiveResource`; keep
  `gate: true`.
- **`useActiveConversations()`** — `useResource(conversationsActiveResource)`
  directly (the whole resource is the active list; drop the `p => p.active` select).
- **`useConversationById(id)`** — unchanged (delegates to `useConversation` + REST
  fallback).

### 5. The four direct `useResource(conversationsResource)` consumers

- **`conversations-view/plugins/queue/web/components/queue-view.tsx`** — replace the
  single read with `conversationsActiveResource` + `conversationsGoneResource`, fold
  both into the existing `useCombinedResources` (alongside queue + tasks);
  `conv.active`→`active`, `conv.recentGone`→`gone`. (Doesn't use system/stats.)
- **`conversation-view/web/panes.tsx` (`useResolveConversation`)** — three keyed
  reads (active/gone/system) combined via `useCombinedResources`; scan
  `[...active, ...gone, ...system].some(c=>c.id===convId)`.
- **`conversation-view/plugins/op-status/web/components/op-status-banner.tsx`
  (`useTitleBySlug`)** — three per-resource `select`s each producing a partial
  slug→title map, `useMemo`-merged with spread order `{...system, ...gone, ...active}`
  (active wins, matches current `[...system, ...recentGone, ...active]`).
- **`recover/web/components/recovery-view.tsx`** — uses only `.pending` as an
  invalidation trigger; subscribe to `conversationsGoneResource` (the gone set is
  the relevant signal for a recovery view) and keep the existing `useEffect`.

### 6. Cleanup / housekeeping

- `grep -rn "conversationsResource\b\|conversationsLiveResource\|ConversationListPayload" plugins`
  — must return only the intended deletions.
- `keyed-resource-scope` check passes by construction (each keyed sub-resource
  declares `identityTable` or `recompute` in its `defineResource` body; the push
  stats resource is not keyed).
- `./equin build` regenerates plugin docs / resource manifests — no hand
  edits to `*.generated.ts`.

## Critical files

- `plugins/tasks/plugins/tasks-core/core/resources.ts` — new descriptors + `RECENT_GONE_LIMIT`
- `plugins/tasks/plugins/tasks-core/core/schemas.ts` — remove aggregate descriptor
- `plugins/tasks/plugins/tasks-core/core/index.ts` — barrel
- `plugins/tasks/plugins/tasks-core/server/internal/resources.ts` — 4 server resources + attempts edge
- `plugins/tasks/plugins/tasks-core/server/internal/queries/conversations.ts` — `convIds` filter, move `RECENT_GONE_LIMIT`
- `plugins/tasks/plugins/tasks-core/server/index.ts` — registration
- `plugins/conversations/web/use-conversations.ts` — hook rewrite
- `plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx`
- `plugins/conversations/plugins/conversation-view/web/panes.tsx`
- `plugins/conversations/plugins/conversation-view/plugins/op-status/web/components/op-status-banner.tsx`
- `plugins/conversations/plugins/recover/web/components/recovery-view.tsx`

## Verification

1. **Build / typecheck:** `./equin build`. The keyed two-arg overload
   enforces ScopePolicy at compile time; `keyed-resource-scope` check must pass.
2. **No dangling refs:** the `grep` above returns only deletions.
3. **App + screenshot the conversation sidebar** (`run` / `verify` skill): active,
   recent-gone, and system sections render identically; the "show more gone"
   affordance still keys off `hasMoreGone`; the `active/total` count label matches.
4. **MCP `query_db`:** `select count(*) from conversations where active=false and
   ended_at is not null and kind <> 'system'` equals the UI's `totalGoneCount`, and
   `hasMoreGone == (count > 30)`.
5. **Delta-sync (live-state-health / `/api/resources/_debug`):** `conversations-active`
   shows `mode:"keyed"`, `identityTable:"conversations"`, `attempts` in `downstream`,
   `coveredOrigins` ⊇ `conversations`; `conversations-gone` surfaces
   `recompute:{kind:"full",reason}`. Trigger one conversation status change (run an
   agent) → the `conversations-active` WS frame is a `delta` (one upsert), NOT a full
   `update`; `conversations-gone` / `-gone-stats` do **not** fire. End a conversation
   → `conversations-gone` ships a full update and `-gone-stats` re-pushes. `attempts`
   still receives a scoped delta for the changed conversation's attempt (no FULL).
