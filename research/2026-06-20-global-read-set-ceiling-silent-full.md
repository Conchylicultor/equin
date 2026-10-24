# Read-set ceiling: surface keyed resources that silently FULL on an uncovered table

## Context

Scoped-recompute coverage is now enforced at the **floor**: every DB-backed keyed
live resource must declare `identityTable` *or* an explicit
`recompute: { kind: "full", reason }` opt-out, enforced by the `ScopePolicy`
type constraint plus the `keyed-resource-scope` check (landed via
`research/2026-06-20-global-enforce-keyed-resource-scope-coverage.md`).

The **ceiling** is still unenforced. A keyed resource that *does* declare
`identityTable` but whose loader reads a **second** base table with no covering
`affectedMap` edge silently FULL-recomputes whenever that second table changes —
because the table's origin is not in `coveredOrigins(R)`, so `applyDbChange`
falls into the `affected = null` (FULL) branch (runtime.ts:1554). This gap is
invisible: nothing tells the author that table T's change is degrading their
carefully-scoped cascade to FULL.

The read-set is only known at runtime (`getReadSetIndex()` captures it after
loaders run against a live DB), so this cannot be a static build check. The
honest home is the existing read-set debug pane
(`plugins/debug/plugins/read-set`): for each keyed resource, flag any captured
read-set base table that is **not** in `coveredOrigins(R)` — the precise
"table T silently FULLs you" signal — and show `coveredOrigins(R)` alongside the
captured read-set so the gap is obvious. `RegistryEntry.recompute` lets the pane
distinguish **explicit FULL** (declared opt-out, expected) from **silent FULL**
(intended-scoped resource degrading).

### Why a new section replaces "Missing edges" (not coexists)

The pane already has a heuristic "Diff vs dependsOn → Missing edges" subsection.
It unions the read-sets of a resource's transitive `dependsOn` upstreams and
flags uncovered tables, framed as **"latent stale-UI"**. That framing predates
the L4 change-feed: under L4 an uncovered table is *still delivered* to
`applyDbChange` — it just FULL-recomputes (`affected = null`) instead of leaving
R stale. So the old premise (uncovered ⇒ never refreshed ⇒ stale UI) is no
longer true; the real failure mode is a **silent FULL**, which is exactly what
`coveredOrigins(R)` measures authoritatively (it *is* the runtime's
scoped-vs-FULL routing set, not a `dependsOn`-readSet proxy).

The new ceiling section is therefore the correct successor to "Missing edges":
same underlying gap, accurate failure mode, authoritative source. We **delete**
the "Missing edges" subsection and keep "Over-broad edges" (an orthogonal
cascade-amplification axis that `coveredOrigins` does not subsume).

## Approach

Three small changes: enrich the `_debug` payload, widen the wire schema, add one
pane section and remove the superseded one.

### 1. Server — enrich the `_debug` payload

File: `plugins/framework/plugins/resource-runtime/core/runtime.ts`,
`handleResourcesDebug()` (≈ line 1417).

`coveredOriginsFor(key)` (line 564), `registry` (holding `entry.identityTable`
and `entry.recompute`), and `handleResourcesDebug` all live in the same
`createResourceRuntime` closure, and `handleResourcesDebug` already calls
`rebuildDag()` first — so no new plumbing. Add three fields to each `out` entry
and to the `out` array's inline type:

```ts
identityTable: entry.identityTable,                       // string | undefined
recompute: entry.recompute,                               // { kind: "full"; reason: string } | undefined
coveredOrigins: [...coveredOriginsFor(entry.key)].sort(), // string[] (the real routing set)
```

`coveredOrigins` is the authoritative scoped-vs-FULL routing set (own
`identityTable` ∪ transitive identityTables reachable via `affectedMap` /
`dependsOn` edges). It is memoized by `registry.size`, so calling it per entry is
cheap.

### 2. Wire schema — add the three fields

File: `plugins/debug/plugins/read-set/shared/schema.ts`, `resourceReadSetSchema`.

Gate them defensively (the established pattern in this file) so the response
parses before the server change lands:

```ts
identityTable: z.string().optional(),
recompute: z.object({ kind: z.literal("full"), reason: z.string() }).optional(),
coveredOrigins: z.array(z.string()).default([]),
```

(The sibling `live-state-health` pane declares its own zod view of the same
route; zod strips unknown keys, so the two coexist — unchanged.)

### 3. Web — add the ceiling section, remove "Missing edges"

File: `plugins/debug/plugins/read-set/web/components/read-set-view.tsx`.

**Add** a new authoritative section, rendered above "Diff vs dependsOn":

> **Read-set ceiling — silent FULL recomputes**

Compute client-side from `resources`:

- **Silent FULL (the bug signal):** for each resource with `identityTable` set
  (declared intent to be scoped) and a non-empty `readSet`, the uncovered tables
  are `readSet \ coveredOrigins`. If non-empty → flag. Render the uncovered
  tables as `warning` (or `destructive`) chips, with `coveredOrigins` shown
  alongside as muted chips so the gap reads at a glance. Surface `identityTable`
  as the "self" origin.
- **Explicit FULL (expected, informational):** for each resource with
  `recompute` set, render one muted/info row showing the resource key and
  `recompute.reason`. No warning — this is a documented opt-out, not a
  degradation. This is the distinction the task calls for.
- Resources that are keyed-and-scoped with zero uncovered tables: summarize as a
  muted "N keyed resources fully scoped" line (don't list each).

Reuse the existing `ChipRow` component (`variant="warning"`) and the
`Badge` / `Cluster` / `Stack` / `SectionLabel` primitives already imported.

**Remove** the superseded "Missing edges" subsection:

- Delete the `missing` half of `computeDiff` (keep the `overBroad` half).
- Delete the now-unused `transitiveUpstreams` helper and the `MissingFlag`
  interface.
- In `DiffSection`, drop the "Missing edges" block; keep "Over-broad edges".
  Consider renaming the section header from "Diff vs dependsOn" to
  "Over-broad edges — cascade amplification" since it now holds a single axis.

Update the `Caveat` text: drop the obsolete "missing edge … stale-UI" sentence;
keep the notes that over-broad flags ignore `affectedMap` scoping and that only
loaders that have run since boot appear.

Update the plugin `CLAUDE.md` prose for `plugins/debug/plugins/read-set` to
describe the new ceiling section and the removed missing-edges heuristic (the
autogen reference block is regenerated by `./equin build`).

## Critical files

- `plugins/framework/plugins/resource-runtime/core/runtime.ts` — `handleResourcesDebug()` (~1417), reads `coveredOriginsFor` (564), `entry.identityTable`/`entry.recompute`.
- `plugins/debug/plugins/read-set/shared/schema.ts` — wire contract.
- `plugins/debug/plugins/read-set/web/components/read-set-view.tsx` — pane rendering + diff logic.
- `plugins/debug/plugins/read-set/CLAUDE.md` — prose update.

## Out of scope

- No build/lint check (the read-set is runtime-only — a static check is
  impossible; the floor check already covers what *is* statically knowable).
- No change to the runtime's actual scoped/FULL routing — this is purely a
  diagnostic surface.

## Verification

1. `./equin build` from the worktree (regenerates docs, builds, restarts).
2. Open `http://<worktree>.localhost:9000`, switch to the **Debug** app →
   **Read-set** pane. Browse the app first (Tasks, Agents, Pages) so loaders run
   and populate the read-set; the pane polls every 5s.
3. Confirm the new **Read-set ceiling** section renders:
   - Each keyed `identityTable` resource shows its `coveredOrigins`; any read-set
     table outside it appears as a warning chip ("silent FULL").
   - Any `recompute: full` resource appears in the explicit-FULL list with its
     reason, not as a warning.
   - "Missing edges" is gone; "Over-broad edges" remains.
4. Cross-check one resource against the raw payload:
   `curl -s http://<worktree>.localhost:9000/api/resources/_debug | jq '.resources[] | select(.identityTable) | {key, identityTable, coveredOrigins, readSet, recompute}'`
   and confirm the pane's flagged tables == `readSet - coveredOrigins`.
5. Screenshot the pane with `bun e2e/screenshot.mjs` (or `playwright screenshot`)
   for a visual check.
