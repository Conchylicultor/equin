# Re-key `plugin-changes` review onto live-state invalidation signals

## Context

On the `main` (singularity) worktree, `GET /api/review/plugin-changes` recorded
**~1870 calls** (max 94s / avg 7s). The handler's synchronous work
(`buildPluginTree` × 2 — a full `plugins/` disk tree-walk per side — plus
`getEditedFiles`) periodically freezes the Bun event loop for 30–60s. Collateral:
plain SELECTs spike to 38–45s, `flushNotifies` to 164s, `deliver:*` live-state
pushes to ~87s, while `pgActiveBackends` stays at 1–6 and host loadAvg hits
15–25 — i.e. **event-loop starvation, not DB contention**. The per-call cost is a
separate task; **this task removes the call volume.**

### Root cause

`usePluginChanges` (`web/use-plugin-changes.ts`) is a plain `useEndpoint`
(TanStack `useQuery`). The result only changes on two events that **already have
push signals**:

1. the worktree's edited files changing → `editedFilesResource` (mode
   `invalidate`, keyed by conversationId, file-watcher-backed), and
2. `main` (or the worktree's own branch) advancing → `refHeadResource` (git-watcher).

Yet today every review-pane remount / new conversation / cache-GC (`gcTime` 5min)
re-triggers the full recompute on demand. Both the `PluginChangesSection` body and
the `PluginChangesSummary` badge call the hook, multiplied across every
conversation reviewed over a long session → ~1870 cold computes.

### Outcome

Move the **working-tree** computation server-side into a live-state
`defineResource` keyed on its real invalidation signals, exactly mirroring the
existing `commits-graph` plugin (`commitDeltaResource` /`commitsGraphResource`).
The server then holds one computed snapshot per `(conversationId)`; repeated
mounts share it (no recompute), and recomputes happen **only** when edited files
or a tracked git ref actually change. The **push** path (immutable base/head
SHAs) stays an endpoint.

## Reference precedent (copy its shape)

`plugins/conversations/plugins/conversation-view/plugins/commits-graph/` is the
template — same problem (expensive per-worktree git compute), same solution:

- `shared/protocol.ts` — Zod schema.
- `shared/resources.ts` — client descriptor via `resourceDescriptor<T, Params>(key, schema, initialData)` (imported by **web**).
- `server/internal/resources.ts` — `defineResource({ key, mode: "push", schema, dependsOn, onFirstSubscribe, onLastUnsubscribe, loader })` with the same `key` string; the active-subscriber `Set` + `activeAttemptParams` fan-out pattern (`resources.ts:54-81`).
- `server/index.ts` — `Resource.Declare(...)`.
- web components call `useResource(resource, params)` instead of `useEndpoint`.

## Changes

### 1. Schema + client descriptor

**`plugins/review/plugins/plugin-changes/core/protocol.ts`** — add a real Zod
schema as the source of truth (replaces the loose `z.array(z.any())` in
`core/endpoints.ts`). Mirror the existing interfaces; facets stay opaque:

```ts
import { z } from "zod";
export const PluginChangedFileSchema = z.object({ path: z.string(), status: z.string(), additions: z.number(), deletions: z.number(), from: z.string().optional() });
export const PluginChangeDiffSchema = z.object({
  pluginId: z.string(), name: z.string(), path: z.string(),
  status: z.enum(["added", "modified"]),
  fileCount: z.number(), additions: z.number(), deletions: z.number(),
  files: z.array(PluginChangedFileSchema),
  currentFacets: z.record(z.unknown()),
  mainFacets: z.record(z.unknown()),
});
export const PluginChangesSchema = z.object({ plugins: z.array(PluginChangeDiffSchema) });
```

Derive the existing exported types from the schemas (`export type
PluginChangeDiff = z.infer<typeof PluginChangeDiffSchema>` etc.) so cross-plugin
consumers (facet renderers in `plugin-meta/facets/*`) are unaffected — same type
names, same shapes.

**`plugins/review/plugins/plugin-changes/shared/resources.ts`** (new):

```ts
import { resourceDescriptor } from "@plugins/primitives/plugins/live-state/core";
import { PluginChangesSchema } from "../core/protocol";
import type { PluginChangesResponse } from "../core/protocol";

export const pluginChangesResource = resourceDescriptor<PluginChangesResponse, { conversationId: string }>(
  "review.plugin-changes",
  PluginChangesSchema,
  { plugins: [] },
);
```

### 2. Server resource (working-tree path)

**`plugins/review/plugins/plugin-changes/server/internal/plugin-changes-resource.ts`** (new) —
mirror `commits-graph/server/internal/resources.ts`:

```ts
export const pluginChangesResource = defineResource({
  key: "review.plugin-changes",
  mode: "push",
  schema: PluginChangesSchema,
  dependsOn: [
    // worktree file edits → edited-files resource is keyed { id: conversationId }
    { resource: editedFilesResource, map: (p: { id: string }) => [{ conversationId: p.id }] },
    // main / own-branch advance → fan out to active subscribers only
    { resource: refHeadResource, map: activeConversationParams(activeConversations) },
  ],
  onFirstSubscribe: ({ conversationId }) => { activeConversations.add(conversationId); },
  onLastUnsubscribe: ({ conversationId }) => { activeConversations.delete(conversationId); },
  loader: async ({ conversationId }) => computeWorktreePluginChanges(conversationId),
});
```

- `activeConversations: Set<string>` + `activeConversationParams` mirror
  `commits-graph`'s `activeDeltaAttempts` / `activeAttemptParams` (no `refName`
  filter — git-watcher only tracks `main` + this branch, so any notify is
  relevant; same reasoning as commits-graph CLAUDE.md).
- `computeWorktreePluginChanges(conversationId)` = today's `handleWorkingTree`
  body (`handle-plugin-changes.ts:61-79`), moved here. Reuses
  `getConversation`, `getEditedFiles`, `getMainPluginsDir`,
  `computePluginChanges` unchanged. Wrap the `computePluginChanges` call in
  `withHeavyReadSlot(...)` (already imported in this plugin) so a ref-advance
  fan-out across several active conversations can't run N tree-walks at once.
- Return `{ plugins: [] }` when the conversation has no `worktreePath` (instead
  of the endpoint's 404) — resources return values, not HTTP errors.

**`plugins/review/plugins/plugin-changes/server/index.ts`** — add
`Resource.Declare(pluginChangesResource)` to `contributions`; keep the existing
`httpRoutes` entry (push path still served by the endpoint).

### 3. Export `editedFilesResource` from the `code` server barrel

**`plugins/conversations/plugins/conversation-view/plugins/code/server/index.ts`** —
the server resource object is currently only `Resource.Declare`'d, not exported.
Add:

```ts
export { editedFilesResource } from "./internal/edited-files-resource";
```

`dependsOn` needs the **server** resource object (as `commits-graph` imports
`refHeadResource`/`pushesResource` from server barrels). `plugin-changes/server`
already imports `getEditedFiles` from this exact barrel, so no new cross-plugin
edge / no cycle.

### 4. Endpoint → push-only

**`plugins/review/plugins/plugin-changes/server/internal/handle-plugin-changes.ts`** —
remove `handleWorkingTree` (moved to the resource loader; keep the shared
`getMainRoot`/`getMainPluginsDir` helpers where the loader can import them).
`handlePluginChanges` now serves only the push branch (`handlePush`).

**`plugins/review/plugins/plugin-changes/core/endpoints.ts`** — make `pushId`
required (drop `conversationId`, now unused by the endpoint); response schema can
reference the new `PluginChangesSchema`. Keep `concurrency: 2` + `dedupe` for the
push path.

### 5. Web: switch working-tree to `useResource`, split by source

`useResource` and `useEndpoint` can't be called conditionally in one hook (rules
of hooks), and the two sources are genuinely different (live vs immutable), so
dispatch at the component boundary.

**`plugins/review/plugins/plugin-changes/web/use-plugin-changes.ts`** — replace
with two hooks returning a unified `{ data, isPending, error }` shape:

```ts
export function useWorktreePluginChanges(conversationId: string) {
  const r = useResource(pluginChangesResource, { conversationId }); // from ../shared/resources
  return { data: r.pending ? undefined : r.data, isPending: r.pending, error: r.error };
}
export function usePushPluginChanges(conversationId: string, pushId: string) {
  return useEndpoint(getPluginChanges, {}, { query: { pushId } }); // already { data, isPending, error }
}
```

**`web/components/plugin-changes-section.tsx`** and
**`plugin-changes-summary.tsx`** — make each a thin dispatcher on `source.kind`
feeding a shared presentational body that takes `{ data, isPending, error,
conversationId }`. Extract the current `PluginChangesSection` render body
(expand-all + `PluginChangeCard` list) into a `PluginChangesList` presentational
component; the summary badge is small enough to inline the dispatch. This keeps
exactly one hook per rendered component.

Note: `useResource` with `staleTime: Infinity` + WS push (the live-state default
QueryClient) means **remounts/focus never recompute** — the server snapshot is
reused; recompute only on a real `editedFilesResource` / `refHeadResource` notify.

## Critical files

| File | Change |
|---|---|
| `…/plugin-changes/core/protocol.ts` | Add Zod schemas; derive types via `z.infer` |
| `…/plugin-changes/shared/resources.ts` | **new** — client `resourceDescriptor` |
| `…/plugin-changes/server/internal/plugin-changes-resource.ts` | **new** — `defineResource` + active-set fan-out + `computeWorktreePluginChanges` |
| `…/plugin-changes/server/internal/handle-plugin-changes.ts` | Drop `handleWorkingTree`; push-only |
| `…/plugin-changes/server/index.ts` | `Resource.Declare(pluginChangesResource)` |
| `…/plugin-changes/core/endpoints.ts` | `pushId` required; reuse schema |
| `…/code/server/index.ts` | Export `editedFilesResource` |
| `…/plugin-changes/web/use-plugin-changes.ts` | Split into worktree (`useResource`) + push (`useEndpoint`) |
| `…/plugin-changes/web/components/plugin-changes-section.tsx` | Dispatch on `source.kind`; extract presentational body |
| `…/plugin-changes/web/components/plugin-changes-summary.tsx` | Dispatch on `source.kind` |

## Verification

1. `./equin build` (regenerates plugin docs/registry; runs checks). Confirm
   `plugins-doc-in-sync`, `plugin-boundaries`, and `type-check` pass — note
   `core` now exports schema values, `shared/resources.ts` is web-private,
   `code/server` gains one export.
2. Open the app at `http://<worktree>.localhost:9000`, open a conversation's
   **Review → Plugin Changes** pane. Confirm the section + count badge render
   identically to before.
3. Confirm the **invalidation signals fire**: with the pane open, edit a file in
   the worktree → the plugin list updates without a manual refresh (file-watcher →
   `editedFilesResource` → cascade). The push tab (immutable) still loads via the
   endpoint.
4. Confirm **call volume collapses**: tail `~/.singularity/worktrees/<wt>/logs/`
   (or the runtime-profiler / `query_db` on the slow-op store) and verify
   `/api/review/plugin-changes` is now hit only for push reviews, and the
   working-tree compute runs once per real change instead of per mount/focus.
   Repeatedly closing/reopening the review pane should issue **zero** new computes
   (server snapshot reused).
5. Optional: `bun test plugins/review/plugins/plugin-changes` if any co-located
   logic tests exist for the compute helpers.

## Out of scope

- Reducing the **per-call** cost of `buildPluginTree` × 2 (separate task — the
  amplifier). This task removes the call frequency.
- Converting the push path to a resource (its result is immutable once the push
  lands; an endpoint with `staleTime: Infinity` already fetches it once).
