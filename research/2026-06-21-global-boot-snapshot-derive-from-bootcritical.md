# Derive boot-snapshot hydration from the server's bootCritical declaration

**Date:** 2026-06-21
**Category:** global (live-state primitive + boot-snapshot infra)
**Status:** Plan — awaiting approval

## Context

A live-state resource opts into pre-paint hydration ("boot-critical") **two-sidedly**, and the two
sides are hand-maintained separately so they silently drift when a resource is split / renamed /
removed:

- **Server (single source of truth):** `Resource.Declare(myResource, { bootCritical: true })` in the
  server plugin's `contributions`. The server reads the set generically
  (`Resource.Declare.getContributions().filter(c => c.bootCritical)`) to warm those loaders behind the
  readiness barrier and to build `GET /api/resources/boot-snapshot` → `{ resources: Record<key, value> }`.
- **Client (the drift-prone duplicate):** `BootSnapshot.Hydrate({ descriptor: myResource })` in the
  *web* plugin's `contributions` (21 call sites across 13 barrels). This self-registers the descriptor
  into a module-level map; the boot task iterates that map and hydrates each descriptor whose key is in
  the snapshot.

During the recent conversations-resource decomposition (commit `de45e926b`), a stale
`BootSnapshot.Hydrate({ descriptor: conversationsResource })` pointed at the deleted aggregate. That
particular case surfaced as a **build-time barrel-import error** (the descriptor export was gone). But
the dangerous, *silent* class is the opposite: when you split a resource into N sub-resources and
forget to add a `Hydrate` for one of them, **nothing errors** — that list just loses pre-paint
hydration and flashes its default value on cold load until the WS sub-ack arrives.

**Outcome wanted:** the client stops maintaining a parallel list. The server's `bootCritical`
declaration is the single source; the client *derives* hydration from the snapshot keys the server
already sends, and any key it cannot honor fails **loudly** instead of silently.

`dependsOn` drift (the other half of the originating note) is **already structurally protected** and
out of scope: `dependsOn` edges reference the upstream by imported *handle object*
(`{ resource: conversationsActiveResource, … }`), so a rename/removal is a compile-time error at the
import site. The read-set debug pane (`plugins/debug/plugins/read-set/`) additionally surfaces
over-broad / uncovered edges at runtime. No change needed there.

## Approach (recommended)

Keep `Resource.Declare(..., { bootCritical: true })` exactly as-is (**server is untouched**). Replace
the client's hand-maintained descriptor list with a generic descriptor registry that the snapshot keys
resolve against:

1. **Add a generic descriptor registry to the live-state core.** The descriptor is the only artifact
   shared between the two runtimes; registering it there gives the client a key→descriptor lookup it
   can build before first paint.
2. **Rewrite the boot task to iterate the snapshot keys** (server-authoritative) and resolve each via
   the registry — instead of iterating a client-side list. A snapshot key with no registered
   descriptor is a real bug; file it loudly.
3. **Delete `BootSnapshot.Hydrate`** and all 21 call sites.

This makes resource splits a **server-only edit**: create the new descriptors (they self-register),
add their `Resource.Declare(..., { bootCritical })`, done. The client auto-derives — no second list to
keep in sync, and the silent-loss class is gone.

### Why not move `bootCritical` onto the descriptor?

Considered and rejected as unnecessary churn. With this approach the client declares `bootCritical`
**nowhere** — it derives entirely from the snapshot the server built from its single declaration. That
already achieves single-source. Moving the flag onto the descriptor would also rewrite the server
warm-up path and all 21 descriptor-creation sites for no additional drift-safety.

## Implementation

### 1. Descriptor registry — `plugins/primitives/plugins/live-state/core/resource.ts`

Add a module-level registry and have all three factories populate it:

```ts
// Module-level key→descriptor registry. Populated by descriptor-module evaluation
// (the factory call runs on import), so a key→descriptor lookup exists before first
// paint — boot-snapshot hydration resolves snapshot keys against it. Keys are unique
// per resource by construction.
const byKey = new Map<string, ResourceDescriptor<unknown>>();

function registerDescriptor(d: ResourceDescriptor<unknown>): void {
  const existing = byKey.get(d.key);
  // Dev guard: a genuine key collision (two distinct descriptors, same key) would
  // silently shadow one resource. HMR re-eval (same logical descriptor, new object)
  // is benign — only warn when schemas differ.
  if (existing && existing !== d && existing.schema !== d.schema) {
    console.warn(`[live-state] duplicate resource descriptor for key "${d.key}"`);
  }
  byKey.set(d.key, d as ResourceDescriptor<unknown>);
}

export function resourceDescriptorByKey(key: string): ResourceDescriptor<unknown> | undefined {
  return byKey.get(key);
}
```

Call `registerDescriptor(<result>)` inside `resourceDescriptor`, `keyedResourceDescriptor`, and
`centralResourceDescriptor` before returning. Central descriptors register harmlessly — they're never
bootCritical, so their keys never appear in the worktree snapshot.

Export `resourceDescriptorByKey` from `live-state/core/index.ts` (alongside the factories) and ensure
it flows through the `live-state/web` re-export (same pattern as `resourceDescriptor`). This stays
inside the internal `resource.ts` file (not the barrel `index.ts`), so barrel-purity / no-plugin-import
checks are satisfied; it adds no new cross-plugin edge.

### 2. Boot task — `plugins/infra/plugins/boot-snapshot/web/internal/boot.ts`

Flip the iteration to be snapshot-driven, and file a loud crash report for any unresolved key:

```ts
import { Core } from "@plugins/framework/plugins/web-sdk/core";
import { fetchEndpoint } from "@plugins/infra/plugins/endpoints/web";
import { hydrateResource, resourceDescriptorByKey } from "@plugins/primitives/plugins/live-state/web";
import { report } from "@plugins/reports/web";
import { bootSnapshot } from "../../core";

export const bootSnapshotTask = Core.Boot({
  run: async () => {
    // The snapshot ships ONLY bootCritical resources (the server's single source), and
    // omits any whose loader failed this boot — so its keys are the authoritative set to
    // hydrate. We resolve each key to its client descriptor via the live-state registry;
    // a key with no descriptor means a bootCritical resource whose descriptor module was
    // not evaluated before boot — a real bug, surfaced loudly rather than silently lost.
    const { resources } = await fetchEndpoint(bootSnapshot, {});
    const missing: string[] = [];
    for (const key of Object.keys(resources)) {
      const d = resourceDescriptorByKey(key);
      if (!d) { missing.push(key); continue; }
      hydrateResource(d, undefined, resources[key]);
    }
    if (missing.length) {
      // The crash collector's window error listener is NOT mounted yet during the boot
      // window, so a queueMicrotask(throw) would only hit the console. report() is a
      // direct keepalive POST that files a deduped crash task regardless of mount state.
      console.error(`[boot-snapshot] no descriptor registered for: ${missing.join(", ")}`);
      void report({
        kind: "crash",
        source: "boot-snapshot",            // must be in ReportBodySchema's client-reportable enum
        summary: `boot-snapshot: unresolved descriptor key(s): ${missing.join(", ")}`,
        data: { /* per crash-kind schema */ },
      });
    }
  },
});
```

Verify `source: "boot-snapshot"` (or chosen value) is permitted by the client-reportable `source` enum
in `plugins/reports/shared/` — add it if absent — and match the crash kind's `data` shape (see
`plugins/reports/plugins/crash/`). `report()` never throws and uses `keepalive`, so it is safe in the
boot path.

### 3. Delete the client list

- Delete `plugins/infra/plugins/boot-snapshot/web/internal/registry.ts` (the `descriptors` map +
  `register` + `registeredDescriptors` + the `BootSnapshot` slot wrapper).
- Remove the `BootSnapshot` export from `plugins/infra/plugins/boot-snapshot/web/index.ts`. Keep the
  plugin's `Core.Boot` contribution (`bootSnapshotTask`) — that is what `runBootTasks` discovers.
- Remove all 21 `BootSnapshot.Hydrate({ descriptor })` calls and their now-unused descriptor `import`
  lines from the 13 web barrels:
  - `plugins/tasks/web/index.ts`
  - `plugins/conversations/web/index.ts`
  - `plugins/conversations/plugins/agents/web/index.ts`
  - `plugins/conversations/plugins/conversation-view/plugins/op-status/web/index.ts`
  - `plugins/conversations/plugins/conversation-view/plugins/notes/web/index.ts`
  - `plugins/conversations/plugins/conversation-view/plugins/turn-summary/web/index.ts`
  - `plugins/conversations/plugins/conversation-category/web/index.ts`
  - `plugins/conversations/plugins/conversation-progress/web/index.ts`
  - `plugins/conversations/plugins/conversation-preprompt/web/index.ts`
  - `plugins/conversations/plugins/conversations-view/plugins/queue/web/index.ts`
  - `plugins/conversations/plugins/conversations-view/plugins/grouped/web/index.ts`
  - `plugins/shell/plugins/notifications/web/index.ts`
  - `plugins/build/web/index.ts`

  For each barrel that ends up with an empty `contributions: []`, drop the array (and the satisfied
  type import if unused). Several barrels have other contributions and just lose 1–4 lines.

### 4. Docs

- Rewrite `plugins/infra/plugins/boot-snapshot/CLAUDE.md`: the opt-in is now **one-sided** (server
  `Resource.Declare(..., { bootCritical: true })`); the client auto-derives. **Document the new implicit
  invariant:** a bootCritical resource's descriptor must sit in the eager web import graph (it always
  does today because a bootCritical resource is, by definition, read by boot-mounted UI) — if it is
  ever only lazily imported, boot files the loud "unresolved descriptor key" report.
- Add a short note to `plugins/primitives/plugins/live-state/CLAUDE.md` about the descriptor registry /
  `resourceDescriptorByKey`. (Distinct from the observe-time key→schema registry, which is populated
  too late for boot.)
- `./equin build` regenerates the autogen `## Plugin reference` blocks (boot-snapshot's `Slots`/
  `Exports`/`Imported by`, the 13 barrels' `Contributes`/`Uses` lines) and `web.generated.ts`. The
  `plugins-doc-in-sync` / `plugins-registry-in-sync` checks will fail until this runs — expected.

## Why this is safe (validated)

- **Eager evaluation holds for all 13 barrels.** Every boot-critical descriptor is also consumed by a
  `useResource(...)` caller that the barrel pulls in via a contributed component or a re-export (e.g.
  `conversations/web` re-exports `useConversations` from `./use-conversations`, which imports the 4
  conversation descriptors; `tasks/web` re-exports from `./client`; `build/web` imports `BuildButton`
  + re-exports `use-stale-frontend`). No barrel relied on the `Hydrate` import as its *only* eager path.
  Because descriptors are grouped one-module-per-plugin, importing any one symbol registers all of that
  plugin's descriptors.
- **Boot ordering is correct.** `framework/web-core/web/App.tsx` awaits `loadPlugins` (which awaits
  every barrel's dynamic `import()`, evaluating all descriptor modules) *then* `runBootTasks`, and only
  then renders. So the registry is fully populated before the boot task reads it.
- **The one defect found is handled:** the crash collector mounts only after `runBootTasks` resolves,
  so the codebase's usual `queueMicrotask(throw)` would not reach the server during boot — hence the
  direct `report()` call.

## Verification

1. `./equin build` from the worktree (regenerates migrations/docs/registry; runs checks). Fix any
   `type-check` / `plugin-boundaries` / `plugins-doc-in-sync` fallout.
2. `./equin check` clean.
3. **Cold-load happy path** — confirm pre-paint hydration still works (no default-value flash) for a
   boot-critical resource:
   ```bash
   bun e2e/screenshot.mjs --url http://<worktree>.localhost:9000/agents --out /tmp/boot
   ```
   The agent/conversation lists should render populated on first paint, exactly as before.
4. **Loud-failure path** — temporarily comment out a descriptor's eager import (so it doesn't register)
   while leaving its server `Resource.Declare(..., { bootCritical })`; reload and confirm:
   - the console logs `[boot-snapshot] no descriptor registered for: <key>`, and
   - a crash report/task is filed (check `Debug → Reports`, or `query_db` the `reports` table).
   Revert the temporary change.
5. **Drift regression (the original bug)** — sanity-check that adding a new bootCritical resource needs
   **only** a server `Resource.Declare(..., { bootCritical })` + the descriptor; no client edit; and it
   hydrates pre-paint.
6. Watch `logs/live-state.jsonl` on a cold load — no `parse-error` / unexpected `drop` lines for the
   boot-critical keys.

## Critical files

- `plugins/primitives/plugins/live-state/core/resource.ts` — registry + `resourceDescriptorByKey`
- `plugins/primitives/plugins/live-state/core/index.ts` — export the lookup
- `plugins/infra/plugins/boot-snapshot/web/internal/boot.ts` — snapshot-key-driven hydration + loud report
- `plugins/infra/plugins/boot-snapshot/web/internal/registry.ts` — **delete**
- `plugins/infra/plugins/boot-snapshot/web/index.ts` — drop `BootSnapshot` export, keep boot task
- The 13 web barrels listed in step 3
- `plugins/reports/shared/` — add `boot-snapshot` to the client-reportable source enum if needed
- `plugins/infra/plugins/boot-snapshot/CLAUDE.md`, `plugins/primitives/plugins/live-state/CLAUDE.md`
