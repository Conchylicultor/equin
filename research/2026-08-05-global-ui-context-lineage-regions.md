# Generic region markers in the UI-context lineage

## Context

The element-picker captures a `<ui-context …>` tag describing a UI element the
user clicked. It builds a **lineage** by walking the DOM upward. Today that walk
has two unequal mechanisms:

1. **Slot contributions** — `PluginMarkerMiddleware`
   (`plugins/improve/plugins/element-picker/web/internal/marker-middleware.tsx`)
   wraps every contribution in a `display:contents` span carrying
   `data-plugin-id` / `data-slot-id` / `data-contribution-id`, and appends itself
   to a portal-crossing chain via `PortalForwardProvider`. The walk collects the
   **full nested chain**, rendered as `path="pluginA@Slot > pluginB@Slot"`.

2. **Panes** — special-cased. Miller (`…/miller/web/components/column.tsx:93,112`)
   and full-pane (`…/full-pane/web/components/full-pane.tsx:44,47`) stamp
   `data-pane-id`; the walk does **one** `closest("[data-pane-id]")` and reports a
   scalar `paneId`.

Two concrete deficiencies follow from #2 being a special case:

- **(a) Ambiguity.** `pane="deploy-deployment-detail"` names a pane *definition*,
  not its position. For `/deploy/server/:id/dep/:id` the chain is
  `deploy-server-detail │ deploy-deployment-detail`, and a reader cannot tell it
  is the leaf column — or even how many columns there are — without grepping the
  repo and reading the route. (Verified live post-implementation: two columns,
  not the three a reading of the pane definitions suggests.) Miller panes are
  **siblings**, so an upward walk from column 3 crosses only column 3's marker —
  position must be supplied by the producer, never inferred by the walk.
- **(b) Wrong plugin attribution.** `plugin=` reports `apps.deploy.shell` (the app
  shell's `Apps.App` contribution) rather than the plugin owning the pane. The walk
  finds no plugin marker at the pane boundary and keeps climbing. Root cause:
  `_pluginId` **is** stamped on the `Pane.Register` contribution
  (`plugins/framework/plugins/web-sdk/core/context.tsx:51-59`) but is discarded by
  `useSyncPaneRegistry` (`plugins/primitives/plugins/pane/web/pane.ts:1861`
  destructures only `{ pane }`); `PaneInternal` carries no plugin id.

**Intended outcome:** panes stop being a special case. A generic *region* node
folds into the same chain as contributions, so a tab, floating window, or app-rail
entry becomes a one-line wrap with **zero** changes to the picker.

### This is not speculative generality

A second consumer already ships. `plugins/reports/plugins/render-loop/web/internal/
culprit-signature.ts:116,140` hand-rolls its own `closest("[data-pane-id]")` walk
to attribute a render-loop culprit. It wants exactly "what composed this element"
and has no shared vocabulary to ask for it.

`data-pane-id` has **five** independent non-picker readers — two production, three
e2e:

| Consumer | Kind |
|---|---|
| `reports/render-loop/…/culprit-signature.ts:116,140` | production |
| `primitives/overscroll-hint/…/overscroll-detector.ts:240` | production |
| `primitives/pane/e2e/surface-match.ts:146` | e2e |
| `active-data/page-link/e2e/page-link-verify.ts:78` | e2e |
| `agent-manager/pages-nav/e2e/pages-tree-verify.ts:29,56` | e2e |

**`data-pane-id` therefore stays, untouched.** It is a load-bearing DOM convention
with independent readers, not picker-private state. The region marker is *additive*
alongside it. Migrating five call sites for a rename with no functional payoff is
churn we are explicitly not buying.

## Decisions

### Where it lives: `plugins/primitives/plugins/ui-context/`

Named for the concept the repo already has (`<ui-context>`, `UiContextMeta`), and
it holds the walk **next to the model the walk produces**.

It cannot live under `improve/element-picker`: `reports/render-loop` must be able
to consume it, and a reports plugin depending on the Improve app's subtree is a
layering inversion. It should not be a vague `ui-lineage` primitive either — the
subject matter is the ui-context model, not "lineage" in the abstract.

The boundary checker permits any plugin→plugin edge
(`allow("plugin.** -> plugin.**")` in `boundary-config.ts`); the only hard
constraints are runtime isolation and no cycles. `ui-context` depends solely on
`primitives/css/ui-kit` (for `PortalForwardProvider`), so no cycle is possible.
This mirrors `plugins/primitives/plugins/surface-id/` — a leaf carved out so a
low-level primitive could read surface identity without importing `pane`.

**`ui-context` owns** — the node model, the DOM attribute grammar, the
portal-forward chain helpers, the `<UiRegion>` producer, the `collectLineage` walk,
and the `UiContextMeta` token (`serializeUiContext` / `parseUiContext` /
`UI_CONTEXT_FIELDS`) plus `collectMeta`, moved wholesale from element-picker's
`core/internal/token.ts` and `web/internal/collect-meta.ts`.

**`improve/element-picker` keeps** — the interaction: the overlay, hit-testing
(`resolve-target.ts`), the chip, the Improve-draft integration, and
`marker-middleware.tsx`. The middleware **stays opt-in on purpose**: it wraps
*every* slot contribution repo-wide, so that cost should only be paid when the
picker is in the composition. `<UiRegion>` has no such constraint — it is a
handful of explicit call sites — so it lives in the primitive and is always on.

### Wire format: `path` is the single field

`region=` would be redundant with `path`, which already carries the region node
inline. So: **drop `paneId` from `UiContextMeta` / `UI_CONTEXT_FIELDS`, add
nothing.** Regions appear in `path`; `plugin`/`slot`/`contribution` remain as the
innermost-node headline.

`path` currently emits only when `markers.length > 1`; it becomes unconditional
now that it is the sole carrier of region information.

Already-persisted tags carrying `pane="…"` (they live in task descriptions and DB
messages) simply lose that one chip row. No legacy branch — the field-driven
parser ignores unregistered attributes, and `url`/`plugin`/`element` still render.

## Design

### The node model — a discriminated union

`plugins/primitives/plugins/ui-context/core/internal/node.ts`

```ts
/** One slot contribution in the composition chain. Produced by the picker's
 *  opt-in slot-item middleware. */
export interface ContributionNode {
  kind: "contribution";
  pluginId: string;
  slotId?: string;
  /** Author-supplied id, keyed cross-plugin as `pluginId:id`. */
  contributionId?: string;
}

/** One named region of the screen — a miller column, a tab, a window. Produced
 *  explicitly by whoever renders the region: position among SIBLING regions is
 *  not inferable from an upward DOM walk. */
export interface RegionNode {
  kind: "region";
  /** Open set of surface kinds: "pane" | "tab" | "window" | … */
  regionKind: string;
  /** Identity within that kind (pane id, tab id, window id). */
  id: string;
  /** Human position or name within the producer's set — "column 3 of 3".
   *  Free-form: only the producer knows what "where" means for its kind, and
   *  the value is model-facing prose, not machine input. */
  label?: string;
  /** The plugin owning the region's CONTENT (not the one rendering the frame). */
  pluginId?: string;
}

export type LineageNode = ContributionNode | RegionNode;
```

A union rather than one flat all-optional shape: the formatter would otherwise
have to guess the kind from field presence — the exact ambiguity being removed —
and `collectMeta` needs an honest `n.kind === "region"` predicate.

Formatting (same file, so a second consumer cannot re-derive it):

```ts
export function formatLineageNode(n: LineageNode): string {
  if (n.kind === "contribution") {
    return n.slotId ? `${n.pluginId}@${n.slotId}` : n.pluginId;
  }
  const label = n.label ? `[${n.label}]` : "";
  return `${n.pluginId ?? ""}#${n.regionKind}:${n.id}${label}`;
}

/** Outer→inner chain. */
export function formatLineagePath(nodes: LineageNode[]): string {
  return nodes.map(formatLineageNode).join(" > ");
}
```

`@` means "contributes into"; `#` means "occupies". Resulting `path`:

```
apps.deploy.shell@apps.app > apps/deploy/deployments#pane:deploy-deployment-detail[column 3 of 3] > tasks/task-header@PaneToolbar.Item
```

### Attribute grammar — flat attributes, one discriminator

```
data-lineage="contribution"   data-plugin-id data-slot-id data-contribution-id   [unchanged]
data-lineage="region"         data-region-kind data-region-id data-region-label data-plugin-id
```

`data-lineage` is both the discriminator and the single walk selector, so the walk
stays one `closest()` per level. Flat attributes beat a JSON payload here: the
inspector shows `data-region-id="deploy-deployment-detail"` at a glance, existing
`data-plugin-id` / `data-slot-id` assertions survive byte-identical, and there is
no `JSON.parse` per ancestor level on the click path.

### The producer — one component

`plugins/primitives/plugins/ui-context/web/internal/ui-region.tsx`

Component only, not a hook returning props: a hook cannot supply the
portal-forward context (that needs a provider), and a hook+spread pair means
forgetting the spread silently breaks the walk. One component makes the broken
state unrepresentable. It mirrors `PluginMarkerMiddleware` beat for beat.

```tsx
export function UiRegion({ kind, id, label, pluginId, children }: {
  kind: string; id: string; label?: string; pluginId?: string; children: ReactNode;
}) {
  const inherited = usePortalForwardedAttrs()[LINEAGE_ATTR];
  const node = useMemo<RegionNode>(
    () => ({ kind: "region", regionKind: kind, id, label, pluginId }),
    [kind, id, label, pluginId],
  );
  // Memoized so the serialized chain keeps a stable identity across the region's
  // re-renders — otherwise every pane render invalidates the provider value for
  // every portal surface below it.
  const lineage = useMemo(() => appendLineage(inherited, node), [inherited, node]);
  return (
    <PortalForwardProvider name={LINEAGE_ATTR} value={lineage}>
      <span style={{ display: "contents" }} {...regionNodeAttrs(node)}>
        {children}
      </span>
    </PortalForwardProvider>
  );
}
```

`display:contents` generates no box, and `resolve-target.ts` already
traverses-but-never-selects boxless elements, so hit-testing needs no change.

### The walk

`plugins/primitives/plugins/ui-context/web/internal/collect-lineage.ts` — the
existing `collectMarkerLineage` generalized: `closest("[data-lineage]")` instead
of `closest("[data-plugin-id]")`, `readLineageNode()` to branch on the kind, and
the portal-forwarded chain spliced in exactly as today.

### Call sites

**`…/miller/web/components/miller-columns.tsx`** — wrap at the **map site**, not
inside `Column`. The region then covers the column body *and* its `CollapsedBar` /
`ResizeHandle` uniformly (`Column` has three early-return shapes), and `Column`
needs no new props:

```tsx
<UiRegion
  kind="pane"
  id={entry.pane.id}
  label={`column ${i + 1} of ${match.panes.length}`}
  pluginId={paneOwnerFor(entry.pane)}
>
  <PluginErrorBoundary slot="layouts.miller" label={entry.pane.id}>
    <Column entry={entry} … />
  </PluginErrorBoundary>
</UiRegion>
```

**`…/full-pane/web/components/full-pane.tsx`** — same wrap, no `label` (no
siblings to disambiguate).

Both keep their existing `data-pane-id` and its `PortalForwardProvider` untouched.

### Fixing (b) — thread the pane's owning plugin

> **Revised during implementation.** The first attempt assigned `pluginId` onto
> `PaneInternal` at registry-sync. That fails the `react-hooks/immutability`
> lint rule: `internal` is reached through `contribution.pane._internal`, a value
> returned from `useContributions()`, so writing to it mutates hook-owned state.
> The rule is correct and was not silenced.

Ownership lives **beside** the pane record, mirroring the `paneObjectByInternal`
WeakMap already in the same file for the same shape of problem (data that belongs
to a pane but is not knowable at `Pane.define` time). This is also the more honest
model: a pane definition is a plugin-agnostic factory, and ownership is a
*registration* fact, so it belongs to the registry layer.

Three edits in `plugins/primitives/plugins/pane/web/pane.ts`:

```ts
// beside paneObjectByInternal
const paneOwnerByInternal = new WeakMap<PaneInternal, PluginId>();

/** The plugin that registered a pane, or undefined before registry-sync.
 *  Optional rather than throwing: a missing owner degrades an attribution
 *  marker to "region with no owner", not worth taking a layout down for. */
export function paneOwnerFor(internal: PaneInternal): PluginId | undefined {
  return paneOwnerByInternal.get(internal);
}

// useSyncPaneRegistry — iterate the whole contribution, not just { pane }.
// `_pluginId` is PluginId | undefined (a contribution built outside the loader,
// e.g. in tests, carries none), so guard rather than cast.
if (contribution._pluginId) paneOwnerByInternal.set(internal, contribution._pluginId);
```

Exported from the pane web barrel. Consumers call `paneOwnerFor(entry.pane)` —
**no `PaneInternal` field and no `MatchEntry` change.**

### `collectMeta`

```ts
const nodes = collectLineage(el);
// plugin/slot/contribution always describe ONE node — the innermost, of whatever
// kind. A pick inside a pane's own markup therefore reports the pane's owner and
// no slot, instead of climbing to the app shell's Apps.App.
const innermost = nodes.at(-1);
```

Never pair a `plugin=` from one node with a `slot=` inherited from another; the
full truth is always in `path`.

### One load-bearing detail

`collect-meta.ts:40`'s `isMarkerSpan` must generalize from `dataset.slotId` to
`dataset.lineage`. Both producers' spans are JSX in their own source files, so
they also carry a build-stamped `data-source` / `data-ui-owner`. Without this,
`nearestSource` / `nearestOwner` / `preciseSelector` would start reporting
`ui-region.tsx` for picks inside a pane.

## Second consumer — proof the set is open

`plugins/apps-core/plugins/tab-surface/web/components/tab-surface.tsx` already
holds `tab.tabId`, `tab.appId`, and reads `app._pluginId` (line 53):

```tsx
<UiRegion kind="tab" id={tab.tabId} label={tab.title ?? app.id} pluginId={app._pluginId}>
  {renderIsolated(Apps.App.id, app)}
</UiRegion>
```

`path` grows a segment with no picker edit, no field change, no walk change. Same
one-liner for `app-rail` and floating windows.

## Files

| File | Change |
|---|---|
| `plugins/primitives/plugins/ui-context/**` | **new** — node model, attrs, append/parse, `<UiRegion>`, `collectLineage`, token, `collectMeta`, `CLAUDE.md` |
| `plugins/primitives/plugins/pane/web/pane.ts` | `paneOwnerByInternal` WeakMap + `paneOwnerFor()` accessor, populated at registry-sync; exported from `web/index.ts` |
| `plugins/layouts/plugins/miller/web/components/miller-columns.tsx` | wrap in `<UiRegion>` |
| `plugins/layouts/plugins/full-pane/web/components/full-pane.tsx` | wrap in `<UiRegion>` |
| `plugins/improve/plugins/element-picker/web/internal/marker-lineage.ts` | **deleted** — contents move to `ui-context` |
| `…/element-picker/web/internal/marker-middleware.tsx` | stamp `data-lineage="contribution"`, append a `ContributionNode` |
| `…/element-picker/core/internal/token.ts`, `web/internal/collect-meta.ts` | moved to `ui-context`; drop `paneId`, emit `path` unconditionally |
| `…/element-picker/web/components/ui-context-chip.tsx` | import the token from `ui-context` (stays field-driven — no per-field edit) |

Not touched: `data-pane-id` and all five of its readers; `resolve-target.ts`;
`overscroll-hint`; the e2e scripts.

## Migration order

Each step compiles, passes `./equin check`, and leaves the repo green.

1. **`primitives/pane`** — add the `paneOwnerByInternal` WeakMap + `paneOwnerFor()`
   accessor + the registry-sync population. Additive, no consumers yet. ✅ landed
2. **Create `primitives/ui-context`** — node model, attrs, append/parse,
   `<UiRegion>`, `collectLineage`. Nothing imports it yet.
3. **Move the token + `collectMeta`** into `ui-context`; element-picker re-points
   its imports; delete `marker-lineage.ts`; generalize `isMarkerSpan`. **Behavior
   byte-identical** — `collectMeta` still reads `paneId` via `closest("[data-pane-id]")`
   in this step. Pure move.
4. **Cutover (atomic)** — miller + full-pane wrap in `<UiRegion>`; `collectMeta`
   drops the `[data-pane-id]` read in favour of the region node; `token.ts` drops
   the `paneId` field and emits `path` unconditionally. Both (a) and (b) fixed.
5. **Second consumers** — `tab-surface`, then optionally migrate
   `reports/render-loop/culprit-signature.ts` off its hand-rolled walk onto
   `collectLineage`.
6. **Docs** — new `ui-context/CLAUDE.md`; update element-picker's "DOM → plugin
   mapping" / "Surviving portals" / "Token format" sections (they name
   `data-pane-id` and the field list explicitly). `./equin build` regenerates
   the autogen blocks and `docs/plugins-*.md`.

## Verification

1. `./equin build`, then `./equin check` (`plugin-boundaries`,
   `type-check`, `plugins-doc-in-sync`, `plugins-registry-in-sync`).
2. `./equin test plugins/improve/plugins/element-picker` and
   `./equin test plugins/primitives/plugins/ui-context`. Test deltas:
   - `portal-lineage.test.tsx` — imports move; `appendLineage` fixtures gain
     `kind: "contribution"`; **add** a case wrapping `<UiRegion>` around
     `<PluginMarkerMiddleware>` around a portal, asserting the mixed `path`.
   - `ui-context-chip-fields.test.tsx`, `token.test.ts` — drop the `paneId`
     fixture field. Both stay field-driven, so no per-field edits.
   - `ui-context-read-render.test.tsx`, `resolve-target.test.ts` — untouched.
3. **Live check** — deploy, open
   `http://<worktree>.localhost:9000/deploy/server/<id>/dep/<id>`, use the
   element-picker on the deployment detail's Overview card, and confirm the chip
   shows `plugin` = the deployments plugin (not `apps.deploy.shell`) and a `path`
   ending in `…#pane:deploy-deployment-detail[column 3 of 3]`.
4. **Regression on the untouched readers** —
   `bun plugins/primitives/plugins/pane/e2e/surface-match.ts` and
   `bun plugins/apps/plugins/agent-manager/plugins/pages-nav/e2e/pages-tree-verify.ts`
   must still pass unchanged, proving `data-pane-id` was not disturbed.
