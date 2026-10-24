# Unify slot discovery onto a complete runtime walk

## Context

Factory-created render slots nested 2+ levels deep are **silently dropped** from
the reorder manifest. `definePaneToolbar(...)` returns `{ Start, End, Host }`
where `Start`/`End` are render slots; exposing it as `export const Sonata = { Toolbar: definePaneToolbar(...) }`
puts the slots at `Sonata.Toolbar.Start` — three levels deep. They render fine,
but reorder quietly never works for them: no error, no failed check, no warning.
The only "fix" today is a hand-written rule ("export the factory result one
level deep, like `TaskDetail`/`SonataToolbar`") that a human must know and
comment by hand (see the comment at
`plugins/apps/plugins/sonata/plugins/shell/web/slots.ts:185`).

Root cause is in the slots facet's **runtime object-walk**,
`collectRuntimeSlots` (`plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts:88`):
it descends only **one object level** into each barrel export. Two structural
defects make the discovery fragile and force a parallel code path:

1. **The walk is depth-capped at one level** → factory slots nested deeper are
   invisible (the actual bug).
2. **The `reorder` flag isn't on the slot object** — `defineRenderSlot` captures
   it in a closure (`render-slot.tsx:96`), so the runtime walk can't read it and
   hardcodes `reorder: true`. To recover the flag, a **second** discovery path
   exists — a regex that text-scans `web/slots.ts` (`parseRenderSlots`). That
   path can't see factory slots at all (the `defineRenderSlot` call lives inside
   the factory file, not in `slots.ts`), so the two paths are mutually
   incomplete half-solutions papering over each other.

The fix removes the footgun rather than documenting it: make the slot object
**self-describing**, make the walk **complete** (any depth), and let the runtime
walk be the **single authoritative discovery mechanism** when barrels are
imported — demoting the static text parse to the explicit fallback for the
no-import (`skipBarrelImport`) build mode, where factory slots are fundamentally
undiscoverable by anyone. No new "loud check" is needed because nothing is
silently dropped once the walk is complete.

Why not a global registry instead of a walk: ownership (`pluginId` = the owning
plugin's hierarchy path) is not knowable from a slot's id string and isn't
carried on the slot (plugin id is loader-injected from the filesystem path). The
per-plugin export walk derives ownership "for free" from *which barrel it is
currently inspecting*; a flat side-effect registry can't, and module caching
would attribute a slot to its first importer, not its owner. So the walk stays —
it just needs to stop being depth-capped and stop outsourcing `reorder` to a
regex.

## Approach

### Part A — Self-describing slots + complete walk (fixes the bug)

1. **Store `reorder` on the `RenderSlot`** —
   `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx`.
   - Add `reorder: boolean` to the `RenderSlot<P>` interface (~line 74).
   - In `defineRenderSlot`, after computing `const reorder = config?.reorder ?? true`
     (line 96), assign `renderSlot.reorder = reorder`.
   - Safe for `isSlotLike` (still a function with `.id` + `.useContributions`)
     and for the walk (a slot is recorded, never recursed into, so the extra
     property is never traversed).

2. **Rewrite `collectRuntimeSlots` as a full-depth recursive walk** —
   `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts`.
   - Replace the fixed two-level loop (lines 88–107) with a recursion over each
     barrel's export object graph:
     - For each `[key, val]` via `safeEntries`:
       - `isSlotLike(val)` → record a `SlotDef` (dedupe by `val.id`), do **not**
         recurse into it.
       - else if `val` is a non-null, non-array `object` not yet visited → add to
         a `WeakSet` and recurse into its entries.
       - else (functions that aren't slots, primitives, arrays, React elements) →
         ignore.
     - Track a `groupName` (top-level export key) and `memberName` (immediate
       key) for each found slot, as today, for doc display.
   - Update `runtimeKindHints` (line 81) to read the real flag:
     `if (typeof s.Render === "function") return { kind: "render", reorder: (s.reorder as boolean) ?? true }`.
     Keeps the `.Dispatch`→`dispatch` / else→`slot` inference unchanged.
   - The `WeakSet` cycle guard + skipping arrays/functions keeps it bounded;
     the export-object graph per barrel is tiny (102 `defineRenderSlot`
     call-sites repo-wide), so cost is negligible vs. the already-paid import.

This alone makes `Sonata.Toolbar.Start` land in
`plugins/reorder/shared/reorderable-slots.generated.ts` and makes a future
`reorder: false` factory slot correctly excluded.

### Part B — Unify the two discovery paths

3. **Make the runtime walk authoritative when imports are present** —
   `slots/facet/index.ts` `extract(ctx)` (lines 112–148).
   - When `ctx.importedModules` is non-empty: the runtime walk is the **sole
     source** of slots (it covers all three kinds — render via `.Render`,
     dispatch via `.Dispatch`, plain otherwise — with correct `reorder`).
   - When `ctx.importedModules` is empty (`skipBarrelImport`): fall back to the
     static text parse (`parseRenderSlots` + the two `parseDefineGroup` calls).
     Keep these helpers; only their role changes (primary → no-import fallback).
   - Remove the `_runtimeOnly` tagging and the static-first/runtime-fallback
     merge. Add a comment documenting the two modes.

4. **Reconcile the two `_runtimeOnly` consumers** (the tag no longer exists):
   - `slots/facet/index.ts` `renderDoc` (line 151): list **all** discovered
     slots. Factory slots (`SonataToolbar.Start/End`, `TaskDetail.Section`, …)
     become documented — more complete and removes the special case.
   - `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts:140`:
     drop the `.filter(s => !s._runtimeOnly)` in the `slotGroupToOwner` map so
     factory-defined slot groups also resolve their contribution owners. Verify
     the group-name → owner linking still behaves (the head-segment match at
     lines 152–155).

   > **Consequence:** documenting factory slots regenerates many `CLAUDE.md`
   > files and `docs/plugins-{compact,details}.md`. This is automatic on
   > `./equin build` and enforced by the `plugins-doc-in-sync` check —
   > the diff will be larger than the code change but is correct (these are real
   > extension points). This is the intended outcome of unification, not churn to
   > avoid.

### What is explicitly NOT done

- No new check / warning: a complete walk means nothing is silently dropped, so
  there is nothing to warn about. (The `reorderable-slots-in-sync` check already
  guards manifest drift.)
- The static text parser is **kept**, demoted to the no-import fallback — pure
  static is impossible because factory slots require running code.
- The per-plugin walk (not a global registry) is kept — it is what provides
  ownership attribution.

## Critical files

| File | Change |
|---|---|
| `plugins/primitives/plugins/slot-render/web/internal/render-slot.tsx` | Add `reorder` to `RenderSlot` interface + assign it in `defineRenderSlot` |
| `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts` | Recursive `collectRuntimeSlots`; `runtimeKindHints` reads `reorder`; `extract` runtime-authoritative + static fallback; `renderDoc` lists all slots; drop `_runtimeOnly` |
| `plugins/plugin-meta/plugins/facets/plugins/contributions/facet/index.ts` | Drop `_runtimeOnly` filter in `slotGroupToOwner` (line 140) |
| `plugins/apps/plugins/sonata/plugins/shell/web/slots.ts` | Optional: the `SonataToolbar` could be nested back under `Sonata` again now that nesting works — leave as-is unless desired; update the stale comment at line 185 either way |

Reused, do not reinvent: `isSlotLike` / `safeEntries` (same file), `getFacet`
(`@plugins/plugin-meta/plugins/facets/core`), the manifest filter in
`reorderable-slots-gen.ts:75-79` (unchanged — already keys on `kind === "render"
&& reorder !== false`).

## Verification

1. `./equin build` — regenerates `reorderable-slots.generated.ts`, the
   config origins, and the plugin docs; runs checks (incl. `reorderable-slots-in-sync`,
   `plugins-doc-in-sync`, `type-check`).
2. Confirm the previously-dropped slot now appears: temporarily nest a toolbar
   under a group (e.g. re-nest `Sonata.Toolbar = definePaneToolbar(...)`),
   rebuild, and grep
   `plugins/reorder/shared/reorderable-slots.generated.ts` for
   `sonata.toolbar.start` — it must be present with the right `pluginId`.
   (Revert the temporary nesting after confirming.)
3. Confirm `reorder: false` is honored: a render slot defined with
   `{ reorder: false }` (e.g. `sonata.home`) must remain **absent** from the
   manifest after the change (verifies the self-describing flag is read, not
   hardcoded to `true`).
4. `bun test plugins/plugin-meta/plugins/facets` if facet unit tests exist;
   otherwise add a focused `bun:test` for `collectRuntimeSlots` covering: depth-1
   group, depth-2 factory nesting, `reorder:false`, dispatch slot, and a cyclic
   object (must terminate).
5. Visually verify reorder works on a deep factory slot in the running app
   (enter reorder edit mode on a `definePaneToolbar` zone via
   `http://<worktree>.localhost:9000`).
