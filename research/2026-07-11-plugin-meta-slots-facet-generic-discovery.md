# Slots facet: generic file discovery in the barrel-free path

## Context

The `slots` facet (`plugins/plugin-meta/plugins/facets/plugins/slots/`) extracts
each plugin's `defineRenderSlot` / `defineMountSlot` / `defineWrapperSlot` /
`defineSlot` / `defineDispatchSlot` declarations. It has two discovery modes:

- **Barrel-import mode** (`ctx.importedModules` present): a runtime walk over the
  barrel export graph. Authoritative — finds slots at any nesting depth, in any
  file, including factory-produced slots.
- **`skipBarrelImport` mode** (`ctx.importedModules` empty): a static text parse
  of **exactly one hardcoded path** —
  `readIfExists(join(ctx.dir, "web", "slots.ts"))`
  (`plugins/.../slots/facet/index.ts:166`).

The second mode is the one consumed by the closure engine, the
`composition-closure` check, `./equin build --composition`, docgen/codegen,
release, the boundary/config checks, and the **server hot-path plugin tree**
(`plugin-tree/server/internal/structure-tree-cache.ts` → `GET
/api/plugin-view/tree`, i.e. the Studio graph/detail panes). ~20 call sites pass
`skipBarrelImport: true`.

### The bug

A plugin that declares its slots in **any file other than `web/slots.ts`** (e.g.
`web/slot.ts`, or a factory/helper file) gets an **empty slots facet** in
barrel-free mode. It still renders correctly at runtime and still appears in
`docs/plugins-details.md` (docgen's *enriched* tree imports barrels), so nothing
looks broken — but `classifyEdges` (`closure/core/classify-edges.ts:76-82`) never
registers a `groupOwner` for that plugin's slot group. Every **soft edge** into
that plugin therefore vanishes from the closure graph.

The symptom is remote from the cause: a composition that selects a contributor to
such a slot fails `composition-closure` with *"selects X, which is not a genuine
soft option"* — reading as "your manifest is wrong" when the manifest is right and
a **filename** is wrong. Hit while adding the `website` composition:
`apps.sonata.audio.instruments` declared its slot in `web/slot.ts`, so
`apps.sonata.audio.piano` looked like a non-option.

### Why this is a real design violation (not just an edge case)

`buildPluginTree` documents (`plugin-tree.ts:334-337`) that the barrel-free path
is safe precisely because *"the other 7 facets parse files from disk and populate
without barrels"* — only the 2 runtime facets (`contributions` runtime half,
`registrations`) need imported modules. `classifyEdges` consumes exactly three
facets — `cross-refs`, `slots`, `contributions.static` — all of which are meant
to be **static-complete**. The slots single-file read silently breaks that
contract: `slots` is *not* static-complete, so `skipBarrelImport` is not actually
lossless for it. The hardcoded `web/slots.ts` is the fragility.

## Approach

Replace the single hardcoded-file read with a **directory walk over `web/`**,
running the existing marker parse on every source file — exactly mirroring the
precedent already used by the `routes` and `cross-refs` facets. No new primitive,
no new convention, no filename rule to remember.

- **Precedent** — `routes/facet/index.ts:237-238` (`walkFiles(join(ctx.dir,
  "core"), files)` + per-file `markerCallSpans`) and `cross-refs/facet/index.ts`
  (`walkFiles(runtimeDir, files)` + per-file `findImports`). The slots facet is
  the lone outlier hardcoding a single filename.
- **`walkFiles`** (`parse-utils/core/helpers.ts:465`) recursively enumerates a
  directory's `.ts`/`.tsx` files, **already skipping `plugins/` (sub-plugin
  trees — separate nodes), `node_modules`, and `__tests__`/`*.test.*`**. So
  `walkFiles(join(ctx.dir, "web"), files)` yields exactly *this* plugin's own web
  source, never a child plugin's. It reads through the ambient `ctx.fs` snapshot
  (`runWithFsSnapshot`), so per-plugin walking is cheap — the same snapshot
  `cross-refs`/`routes` already walk in the same pass.
- **Scope: `web/` only.** Slot builders are web-sdk web constructs; the current
  fallback already targets `web/`. Walking `web/` generically across *files* is
  the whole fix. (Walking all runtimes would only add empty scans.)
- **Group-name derivation is unchanged.** `parseSlotCalls` /
  `parseDefineGroup` already derive `groupName` per-file (from `export const Group
  = {` context or member name). Feeding a different filename through the *same*
  parser yields identical results — only the set of files fed to it changes.

### The change (single file)

`plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts`, `extract()`
barrel-free branch (lines 165-190):

1. Add `walkFiles` to the existing `@plugins/.../parse-utils/core` import.
2. Replace:
   ```ts
   const src = readIfExists(join(ctx.dir, "web", "slots.ts"));
   if (src) { const original = stripTypes(src); const masked = maskSource(original); … }
   ```
   with a walk over `join(ctx.dir, "web")`, running the same five parse calls
   (`defineRenderSlot`/`defineMountSlot`/`defineWrapperSlot` via `parseSlotCalls`;
   `defineSlot`/`defineDispatchSlot` via `parseDefineGroup`) on each file's
   `stripTypes` → `maskSource` output.
3. **Dedupe by `slotId`** across files (a `Set<string>`, first-writer-wins) —
   mirroring the barrel-walk's `seen` set, so a slot re-exported/aliased in a
   second file is counted once.
4. Update the explanatory comment (lines 155-164) — the fallback is no longer
   `web/slots.ts`-only and no longer "cannot see slots in other files"; the
   remaining limitation is only *dynamic/factory ids* (non-static-literal ids,
   already skipped at line 44), not *other files*.

Sketch:
```ts
const slots: SlotDef[] = [];
const seen = new Set<string>();
const files: string[] = [];
walkFiles(join(ctx.dir, "web"), files);
for (const file of files) {
  const src = readIfExists(file);
  if (!src) continue;
  const original = stripTypes(src);
  const masked = maskSource(original);
  const fileSlots: SlotDef[] = [
    ...parseSlotCalls(original, masked, "defineRenderSlot", "render"),
    ...parseSlotCalls(original, masked, "defineMountSlot", "mount"),
    ...parseSlotCalls(original, masked, "defineWrapperSlot", "wrap"),
    ...parseDefineGroup(original, "defineSlot",
      (memberName, slotId, groupName): SlotDef => ({ memberName, slotId, groupName, kind: "slot", contributors: [] })),
    ...parseDefineGroup(original, "defineDispatchSlot",
      (memberName, slotId, groupName): SlotDef => ({ memberName, slotId, groupName, kind: "dispatch", contributors: [] })),
  ];
  for (const slot of fileSlots) {
    if (seen.has(slot.slotId)) continue;
    seen.add(slot.slotId);
    slots.push(slot);
  }
}
return slots;
```

### Files

- **Modify:** `plugins/plugin-meta/plugins/facets/plugins/slots/facet/index.ts`
  (the `extract()` barrel-free branch only).
- **Update doc:** `plugins/plugin-meta/plugins/facets/plugins/slots/CLAUDE.md`
  ("Extracts `defineSlot()` from each plugin's `web/slots.ts`" → "from any file
  under the plugin's `web/`").
- **Reuse (no change):** `walkFiles`, `readIfExists`, `stripTypes`, `maskSource`,
  `parseSlotCalls`, `parseDefineGroup` — all already present.

### Deliberately not doing

- **No enforcement check** ("slots must live in `web/slots.ts`"). That keeps the
  hardcoded path and only makes the failure louder; the user asked to *remove* the
  fragility, not gate it. The generic walk eliminates the class of bug at the
  source.
- **No restriction to barrel-exported slots.** The walk may now surface an
  internal (non-barrel-exported) slot the barrel-walk mode would miss. This is
  harmless: an unexported slot has no cross-plugin contributors, so it owns no
  cross-plugin soft edge; registering its (globally-unique PascalCase) group owner
  changes no edge. Following the `routes` precedent (walk everything) over
  re-export resolution keeps the change minimal.

## Verification

1. **Reproduce the original failure** on `main`'s parser shape, then confirm the
   fix. The `sonata` instruments/piano case is the live repro:
   ```bash
   ./equin build            # regenerates facets/registries, runs checks
   ./equin check composition-closure
   ```
   With a composition that selects `apps.sonata.audio.piano` (contributor to the
   `apps.sonata.audio.instruments` slot declared outside `slots.ts`), this check
   fails before the change and passes after.

2. **Direct facet assertion** — add/extend a `bun:test` beside the facet
   (`slots/facet/`) that builds the tree barrel-free and asserts the slot is
   found from a non-`slots.ts` file:
   ```bash
   bun test plugins/plugin-meta/plugins/facets/plugins/slots
   ```
   Assert `getFacet(node, slotsFacetDef)` for a plugin whose slot lives in
   `web/slot.ts` (or the real `apps.sonata.audio.instruments`) is non-empty and
   carries the right `groupName`.

3. **Closure test** — the existing engine test must stay green (barrel-free tree
   feeds it):
   ```bash
   bun test plugins/plugin-meta/plugins/closure/core/closure.test.ts
   ```

4. **Studio graph (server hot path)** — after `./equin build`, open
   `http://<worktree>.localhost:9000/studio`, focus a plugin whose slot lives
   outside `slots.ts`, and confirm its soft (contribution) edges now appear in the
   graph/detail panes — these read the same `skipBarrelImport` tree.

5. **Full check sweep** — `./equin check` (docgen/codegen, boundaries,
   `facets:render-complete`, `plugins-doc-in-sync`) to confirm no regression in
   the barrel-free consumers.
