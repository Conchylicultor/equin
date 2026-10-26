# Surface-keyed view params (replace the pane's single `;view`)

## Context

A DataView inside a pane binds its active view to the pane's reserved `;view`
URL key, and a second DataView claiming it in the same pane instance **throws**
(`usePaneViewParam`'s claim registry). Any pane whose body holds two DataViews
that can be open together crashes one of them — the deployment pane did
(History + Secrets: "Open Secrets" opened a section that crashed, so the link
"did nothing"). The escape hatch, `viewParam={false}`, is per call site
(16 of them today) and cannot be known by a plugin contributing one section of
a pane it does not own.

Goal: make the collision **inexpressible** (fix-ladder rung 1). Every DataView
surface gets its own URL key derived from its id, so nothing is claimed, nothing
throws, nothing is declared, and every list is addressable.

## Behaviour

- **Key** = `view.<storageKey>` — e.g. `;view.deploy.deployment.history=failures`,
  `/sonata;view.sonata.library=all`. The `view.` prefix makes the family disjoint
  from declared keyed params (identifiers, no `.`) and is needed because some
  DataView ids have no dot (`tasks-list`). Pane names no DataView: it owns a
  generic "surface view key" family.
- **Written only when the active view ≠ the surface's static default**
  (`defaultView` if authored, else the first authored view). On its default a
  list adds nothing.
- **Absent key** → this device's last pick → static default (unchanged
  resolution order: pinned → URL → persisted → defaultView → first).
- **A restored non-default view is stamped into the URL** (replace), so the
  address always reproduces the screen. Switching back to the default removes
  the key. All writes replace (no Back entry per switch).
- **Pinned surfaces** and DataViews outside a pane bind nothing, as today. A pane
  with no URL part of its own that is not its app's landing pane binds nothing.
- **No alias** for the old `;view=`: an old link's key is simply dropped (pane
  drops unknown keys), the list shows its device/default view. All in-repo uses
  are migrated.
- Key order in the URL: declared keyed params (declaration order), then surface
  keys sorted — deterministic.

## Design

### Pane (`plugins/primitives/plugins/pane`)

- `core/route.ts`: replace `RESERVED_VIEW_PARAM` with the surface-key family:
  `SURFACE_VIEW_PREFIX = "view."`, `surfaceViewKey(surface)`,
  `isSurfaceViewKey(name)` (prefix + `[A-Za-z0-9._-]+`). `readKeyedParams`
  keeps declared names **and** any surface key; `slotKeyedParamNames` /
  `keyedPairs` / `fillSegment({ ownSlot })` / `indexKeyedSuffix` /
  `readIndexKeyedParams` write declared names then the slot's surface keys
  (sorted). `assertKeyedParams` keeps refusing a declared `view` / `:view`
  (the prefix stays reserved).
- `web/pane.ts`:
  - `RESERVED_VIEW_SUFFIX` / `splitReservedViewPart` (pane declaring no keyed
    params): strip a trailing run of `;view.<surface>=<value>` pairs only — any
    other raw `;` stays text.
  - Resolve step: `withoutReservedView` → strip every surface key from
    `params`/`fullParams`; `MatchEntry.view?: string` → `views: Readonly<Record<string, string>>`
    (surface → view id), used by the cache-reuse check.
  - `setParams` / `useSetParams` preserve all surface keys; `sameAddress`
    ignores them; `useIndexMatch` reads the index's surface keys.
  - `usePaneViewParam(surface)`: binds `surfaceViewKey(surface)` under the same
    `bound` rule the reserved key had; **delete the claim registry and the
    throw**; `name` parameter and `null` opt-out go away (data-view passes
    nothing when pinned). `set(undefined)` removes the key (verify
    `setKeyedParam`'s `withValue` deletes on `undefined`).

### Data-view / view-core

- Delete `DataViewProps.viewParam` (`core/internal/types.ts`), its `body-types`
  pick, and plumbing in `data-view.tsx` / `data-view-switcher.tsx` /
  `useDataViewModel` (incl. the pinned+viewParam throw). `useDataViewModel`
  calls `usePaneViewParam(storageKey)` unless pinned.
- The URL is **derived from the active id, one writer**: in
  `view-core/web/internal/use-view-model.ts`, once instances are known, an effect
  computes `staticDefault = resolveActiveId(instances, { defaultView })` and
  `desired = activeId === staticDefault ? undefined : activeId`, and calls
  `url.set(desired)` when `url.value !== desired`. `setActiveView`
  (`view-switcher/web/internal/use-active-view.ts`) stops writing the URL itself;
  the adopt-URL-locally effect stays. This one effect gives restore-stamping,
  switch writes, switch-back removal, and self-heal of a stale URL id.
- Remove every `viewParam={false}` call site (16; e.g.
  `apps/deploy/deploy-history/.../deploy-history-section.tsx`,
  `build/build-logs/.../build-log-section.tsx`, `history/dialog/.../version-history-dialog.tsx`)
  with its explanatory comment. A DataView in a dialog/popover is outside any
  pane surface entry and still binds nothing.

### Migrations

- e2e parts files: `sonata/plugins/library/e2e/proto-1792667077-4bakda.parts.json`,
  `prototypes/plugins/gallery/e2e/proto-1792667078-9zh04x.parts.json`
  (`;view=x` → `;view.<storageKey>=x`, ids from `data-views.generated.ts`).
- Compare tool: `prototypes/plugins/compare/e2e/part-metrics.ts` zod doc,
  `prototypes/plugins/compare/CLAUDE.md`.
- Docs: pane `CLAUDE.md` (reserved `;view` + `usePaneViewParam` sections),
  data-view `CLAUDE.md` ("Addressable views", State split row, `viewParam`
  mentions), view-switcher `CLAUDE.md`, sonata player comment.

### Tests

- Rewrite `pane/web/__tests__/view-param.test.tsx`: two surfaces in one pane
  both bind (no throw), keys serialize sorted after declared keys, landing pane
  carries surface keys on the base path, `useSetParams` keeps them, `set(undefined)`
  removes the key, an old `;view=` is dropped, a pane declaring no keyed params
  keeps a non-surface raw `;` as text.
- Update `pane/core/route.test.ts` "reserved `;view`" cases.
- New view-core test for the URL-derivation rule: default → no key; switch →
  key; switch back → removed; persisted non-default → stamped; URL id adopted
  locally; unknown URL id → rewritten to the active.

## Verification

1. `./equin test plugins/primitives/plugins/pane plugins/primitives/plugins/data-view plugins/primitives/plugins/view-switcher`.
2. `./equin build` (checks incl. type-check, docs in sync).
3. Browser on the worktree build: deployment pane — open History + Secrets +
   Messages together, no crash; switch History to Failures → URL gains
   `;view.deploy.deployment.history=failures`; back to Recent → key gone;
   reload a bare URL after leaving Failures → restored and stamped;
   "Open Secrets" link reveals Secrets. `/sonata;view.sonata.library=all`
   opens All.
