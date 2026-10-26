# `./equin plugin move` leaves a tree that builds clean

## Context

Renaming `improve` → `wish` (4be2029e43) needed two hand fixes before `./equin build` passed:

1. **Missed ref** — `improve.element-picker` in the compositions seeds
   (`plugin-meta/composition/core/config.ts`, `self-improvement` pack) and its test.
   The locator scans the compositions *origin* (`compositions.origin.jsonc`), which is
   **derived** from `config.ts` defaults. The mover rewrote the derived file; the build
   regenerated it from the un-rewritten source, putting the old id back.
2. **`@review` markers on a pure rename** — the mover rewrote reorder keys in the
   committed overrides and their origins, but never the `// @hash` chain. It cannot: an
   origin's hash is only known after codegen regenerates it, and the regenerated origin
   is **sorted** (`wish:improve` moved to the end), so a text edit's hash would not match
   anyway. The build then saw each override as stale and re-marked it with the generic
   "the defaults changed" marker. A committed override of a descriptor *without*
   `requiresAuthoredOverride` would have failed `config-origins-in-sync` with no marker
   at all.

Root cause of both: **the mover edits derived files**, and the git-layer hash chain has
no move-aware step the way the user layer does (`applyPluginMoves` → `rewriteConfigFiles`).

## Design

### 1. The source of the compositions manifest is a structural ref site

- `plugin-refs`: new dot-ref site `composition-source`, scanned in
  `COMPOSITIONS_SOURCE` = `plugins/plugin-meta/plugins/composition/core/config.ts`
  (a fixed input, like `BOUNDARY_CONFIG`): every string literal in the array literal
  of an `entryPoints:` / `selectedContributors:` property, read through
  `parseEntryPattern` (range = base id, `!`/`.**` preserved; `**` skipped). Same
  `maskSource` / `matchBracket` / `literalsIn` approach as `scanRuntimeExceptionRefs`.
- `config.ts` is reshaped so every id sits in such a property: helpers take
  `{ entryPoints }` / `{ selectedContributors }` objects
  (`app("home", { entryPoints: ["apps.home.**"] })`,
  `subsystem("data", { entryPoints: ["database.**"] })`,
  `pack("theming", { selectedContributors: [...] })`), and the shared agent-manager
  list becomes `const AGENT_MANAGER = { entryPoints: [...] }` spread into both rows.
  Generated origin content is unchanged (same hash).
- **Guard (check, rung 3)**: `plugin-refs:compositions-source-covers-origin` — every
  id the origin's manifest names is also found in the source scan. A future helper that
  hides an id from the scanner fails here, not in the next rename.
- `config.test.ts`'s duplicated `SELF_IMPROVEMENT` literal list is derived from the
  seeded pack row instead (test code is not a ref site; a pinned copy of seed data
  is a rename hazard).

### 2. The mover never edits derived files

`relocate/cli/internal/plan.ts` `isDerivedFile` also covers `*.origin.jsonc` (and
`*.ancestor.jsonc`): the build regenerates them from their source. The planner keeps
reading them (refs in them still resolve via the checks after the build).

### 3. The build re-stamps overrides whose staleness is a recorded move

New `restampMovedOverrides` in `relocate/core` (owns the ledger, `movedPluginId`,
`rewriteKeys`), called by the build (`build/cli/internal/app-artifacts.ts`) between
`regenerateManifestCodegen` and `seedAuthoredOverrides`:

- Before regen the build snapshots every `config/**/*.origin.jsonc` (rel → text).
- After regen, for each origin whose `@hash` changed (H_old → H_new):
  - re-root the OLD origin's reorder keys through the whole ledger, in order
    (`scanReorderItemRefs` + `movedPluginId`, the same rewrite `applyPluginMoves` does);
  - it is a **pure move** iff the re-rooting changed at least one key AND the result
    equals the new origin with arrays compared order-insensitively (a renamed key
    re-sorts);
  - then every override anchored to H_old — the base `<name>.jsonc` and each
    `@app/<id>/<name>.jsonc` — is re-stamped to H_new, body untouched (the mover
    already re-rooted its keys).
- Anything else falls through to today's behaviour (seed re-mark / origins-in-sync).
  A ledger entry whose old id was later reused can only make the comparison fail →
  marker, never a silent re-stamp.
- Build logs each re-stamp: `[config-v2] re-stamped config/<rel> (plugin move)`.

Docs: relocate `CLAUDE.md` ("What it does", new "Committed overrides follow the
move"), plugin-refs `CLAUDE.md` (site table).

Also clean the leftover guidance comment residue the hand fixes left in
`config/shell/action-bar/item.jsonc` and `config/tasks/task-draft-form/action.jsonc`
(comments only; hash unaffected).

## Files

- `plugins/plugin-meta/plugins/plugin-refs/core/{ts-refs,find,types,index}.ts`, `check/index.ts`, tests
- `plugins/plugin-meta/plugins/composition/core/config.ts`, `config.test.ts`
- `plugins/plugin-meta/plugins/relocate/cli/internal/plan.ts`, `core/internal/restamp-moved.ts` (+ test), `core/index.ts`
- `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts`

## Verification

- Unit tests: scanner on a fixture source; restamp on a scratch `config/` (pure move →
  re-stamped; move + real entry change → untouched; no ledger match → untouched).
- `./equin test` on plugin-refs, relocate, composition.
- `./equin build` passes (origin hash of compositions unchanged).
- End-to-end in a throwaway clone of this worktree's state: `./equin plugin move wish wish2 --dry-run`
  shows `dot:composition-source` edits for `config.ts`, and no `.origin.jsonc` edits.
