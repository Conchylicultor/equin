# ui-context

The **UI-context lineage**: given a DOM element, "what composed this?" — the
outer→inner chain of plugin contributions and named screen regions that produced
it. This plugin owns the node model, the DOM attribute grammar, the
portal-crossing chain helpers, the `<UiRegion>` producer, and the
`collectLineage` walk.

## Why it is its own neutral leaf

Two unrelated consumers need the same answer: the element picker (the
`<ui-context …>` tag a user hands an agent — this plugin's own `element-picker`
sub-plugin) and `reports/render-loop` (which culprit component caused a render
loop). Neither may depend on the other, so the shared vocabulary lives below
both, in a leaf whose only cross-plugin dependency is `primitives/css/ui-kit`
(for the portal-forward bridge). No cycle is possible. Same carve-out reasoning
as `primitives/scope/surface-id`.

The picker is a SUB-plugin, not part of this barrel, for two reasons: its
contribution producer must stay opt-in (below), and its `<ui-context>` chip
needs `error-boundary`, which imports this plugin — the parent never imports its
child, so there is no cycle.

The name is the concept the repo already has (`<ui-context>`, `UiContextMeta`),
and it holds the walk **next to the model the walk produces**.

## The two producers

A lineage node is stamped onto the DOM by exactly one of two mechanisms, and the
split is deliberate:

- **Contributions — opt-in, via the picker's slot-item middleware.** It wraps
  *every* slot contribution repo-wide. That cost should only be paid when the
  picker is actually in the app composition, so the middleware lives in the
  `element-picker` sub-plugin and registers itself from its barrel. This plugin
  supplies only the grammar it stamps (`contributionNodeAttrs`,
  `appendLineage`).

  It hands slot-render **attributes** (a `SlotRender.ItemAttrs` contribution), which slot-render
  stamps on the one element it draws around each contribution. Not a wrapper: a
  wrapper lands wherever the plugin providing it sits, and this one sat inside the
  layout cell a row slot draws — so the slack around a small widget, most of what
  there is to point at, was attributed to whatever region enclosed the slot's
  host. `boxless` comes back with the box, so the grammar can mark a
  `display:contents` box as one the nearest-authored-element walks step through.
- **Regions — always on, via `<UiRegion>`.** A handful of explicit call sites
  (miller columns, full-pane, tabs, floating windows), so there is no composition
  cost to gate. `<UiRegion>` therefore lives here and is unconditional.

`<UiRegion>` is a **component**, not a hook returning props: a hook cannot supply
the portal-forward context (that needs a provider), and a hook + spread pair
means forgetting the spread silently breaks the walk. One component makes the
broken state unrepresentable.

## Regions must supply their own position

A region node carries a free-form `label` — "column 3 of 3" — supplied by the
producer. This is not laziness: **miller panes are siblings**, so an upward DOM
walk from column 3 crosses only column 3's own marker and has no way to see the
other two. Position among siblings is knowable only where the set is rendered.
The value is model-facing prose, not machine input; only the producer knows what
"where" means for its own kind of region.

Likewise `pluginId` on a region is the plugin owning the region's *content*, not
the one rendering the frame — a pane's frame is drawn by the layout renderer,
but the pane belongs to whoever registered it.

## Attribute grammar

`data-lineage` is both the discriminator and the single walk selector, so the
walk stays one `closest()` per level:

```
data-lineage="contribution"   data-plugin-id data-slot-id data-contribution-id
data-lineage="region"         data-region-kind data-region-id data-region-label data-plugin-id
```

Flat attributes rather than a JSON payload: the inspector shows
`data-region-id="deploy-deployment-detail"` at a glance, pre-existing
`data-plugin-id` / `data-slot-id` assertions survive byte-identical, and there is
no `JSON.parse` per ancestor level on the click path.

The skip rule (`data-plugin-id=""` ⇒ drop the node) applies to **contributions
only**. A region with no owning plugin is still collected — its identity is the
whole point, and the plugin is the optional part.

Formatting is `formatLineageNode` / `formatLineagePath` in `core/`: `@` means
"contributes into", `#` means "occupies". `parseLineageNode` /
`parseLineagePath` are their **inverses**, beside them so a consumer wanting the
chain as structure (the chip popover gives each node its own line) can't spell
the grammar differently from the writer. The parse is **total** — a bare
`pluginId` is a legal segment, so an unrecognized one *is* that plugin id and
round-trips back to itself; no failure arm to absorb. `node.test.ts` pins it.

```
apps.deploy.shell@apps.app > apps/deploy/deployments#pane:deploy-deployment-detail[column 3 of 3] > tasks/task-header@PaneToolbar.Item
```

## Reading the grammar: the shared marker walks

`web/internal/marker-walk.ts`, exported from `web/` — `isMarkerSpan`,
`nearestSource` (`data-source="file:line"`), `nearestOwner`
(`data-ui-owner="Name@file:line"`). Used by `collectMeta` here and by
`reports/render-loop`'s culprit attribution; don't re-derive a local copy.

`isMarkerSpan` keys on **`data-lineage`**, not `data-slot-id`. Every marker span
is JSX in its producer's own file, so it carries a `data-source` of its own —
a walk that fails to recognize one reports the *producer's* file for everything
beneath it. `data-slot-id` misses `<UiRegion>`, which would make everything
inside a miller column resolve to `ui-region.tsx`.

## Crossing portals

Popovers, dialogs, menus and the viewport overlay relocate their content to
`document.body`, severing it from the marker spans (which stay in the source
tree) — a naive DOM-ancestry walk loses the whole lineage for portaled UI. So
each producer *also* appends its node to the **portal-forward bridge**
(`PortalForwardProvider` / `usePortalForwardedAttrs` in `primitives/css/ui-kit`),
a React-context bag of `data-*` attributes that crosses portals; every portal
surface re-stamps the bag onto its positioner. The serialized chain rides as
`LINEAGE_ATTR` (`data-plugin-lineage`), and `collectLineage` splices it in ahead
of anything collected inside the portal.

The serialized value **must be memoized** at each producer (both `<UiRegion>`
`useMemo`s exist for this): an unstable string identity invalidates the
`PortalForwardProvider` value for every portal surface below, on every region
re-render.

## Fail loudly

`parseLineage` is deliberately **not** wrapped in a try/catch, and
`readLineageNode` throws on an unrecognized `data-lineage` value. Both values are
written only by this plugin's producers, so a failure there is real corruption to
surface, not an absence to absorb.

## The `<ui-context>` token

`core/internal/token.ts` — the wire format handed to an agent.
`serializeUiContext(meta, provenance)` / `parseUiContext` round-trip it. A
**paired** element, standard XML split — machine coordinates in attributes,
model-facing prose in the body as two sibling tags:

```
<ui-context url="…" plugin="…" slot="…" contribution="…" path="…" inner-slots="…" selector="…" source="…" owner="…"><hint>…</hint><picked-content><element label></picked-content></ui-context>
```

`UI_CONTEXT_FIELDS` is the **single source of truth** for the attribute set:
serialize writes it, parse reads it, and the chip popover renders it, each by
iterating the list — so the three cannot drift (a compile-time exhaustiveness
check forces every `UiContextMeta` key to be registered). Adding a field there
makes it flow everywhere by construction; a field the parser doesn't know is
simply ignored, which is why dropping `pane=` needed no legacy branch.

`plugin`/`slot`/`contribution` describe **one** node — the innermost of whatever
kind — never a plugin from one node paired with a slot from another. `path` is
the full chain and the **sole** carrier of region info, so it is emitted
unconditionally.

`inner-slots` is the downward twin of `path` (`collectInnerSlots`): the slots
whose contributions sit inside the picked element — outermost layer, distinct,
document order, capped. A pick on a bare container (a bar, a wrapper, the slack
between widgets) lies in no slot, so its lineage stops at the pane and its label
is `div`; the inner slots are what say which part of the pane it is. Omitted on
a leaf.

The tag flows verbatim into the agent prompt, hence the constant `<hint>`
explaining what it is and how it was produced, kept apart from the label body so
the model never disentangles framing from data. Values are sanitized
quote/angle-bracket/newline-free so the tag stays single-line and survives the
editor's line-based markdown sync.

A consumer that has to treat the tokens in a text apart from the words around
them uses `splitUiContext(text)`, not the pattern (which
`no-token-identity-outside-owner` keeps to the token's owners): prose runs and
tags in order, each tag with its raw text and parsed meta. A match
`parseUiContext` refuses (no `url` or no label) is its own `malformed` arm, not
prose, so the caller decides what it means.

### The element label: one structure, two readings

The body label (`element`) is an **element descriptor** —
`tag[role=…][type=…] — name`, e.g. `button — Attach UI element` — spelled by
`formatElementDescriptor` and read back by `parseElementDescriptor`
(`core/internal/element.ts`, side by side like the lineage formatter/parser).
The markup head is for the agent (it locates the node); a person never sees it.
`uiContextLabel(meta)` turns the same structure into what the chip shows: the
element's name with its kind ("Attach UI element" · Button), else what its
markup says it is ("Checkbox"), else the owning component ("Spread wheel"),
else the innermost lineage node ("Element picker"), else "Element". A body that
is not a descriptor (a crash token's free-text "slot / label") is shown as-is.

### Provenance

`serializeUiContext(meta, provenance)`'s second argument (`"picked" | "crash"`)
picks the `<hint>` and body tag (`<picked-content>` / `<crash-site>`) out of the
`PROVENANCE` record — the token's only producer-specific part. **Required, not
defaulted**: a default lets a new producer ship a hint that lies. Registering one
is a single edit — `parseUiContext` builds its body-tag alternation from
`PROVENANCE`, and `UI_CONTEXT_RE`'s body is already `[\s\S]*?`.

Provenance is deliberately **not** a `UI_CONTEXT_FIELDS` attribute: it says why
we emit, not where the element is, and a non-`string` union in `UiContextMeta`
would break both the `Exclude<keyof …, "element">` exhaustiveness check and
`parseUiContext`'s `meta[f.key] = v` assignment.

### Meta builders and the wire schema

`collectMeta(el)` — the full pick: lineage **plus** `selector`/`source`/`owner`
read off `el` itself. `collectLineageMeta(el, element)` — ancestors only, for
callers whose `el` is not the subject (a crash boundary's fallback, whose own
`<Line>` carries a `data-source` pointing at `crash-fallback.tsx`); the label is
passed in.

`UiContextMetaSchema` is the zod twin, for producers crossing a trust boundary.
Bound to the interface by a `keyof` set comparison **and** mutual assignability —
assignability alone silently accepts an omitted *optional* field, since
`{…no owner}` and `UiContextMeta` are assignable both ways.

## Not this plugin's business

`data-pane-id` — a separate, load-bearing DOM convention with five independent
readers (render-loop attribution, overscroll-hint, three e2e scripts). The region
marker is *additive* alongside it; nothing here reads or writes it.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The UI-context lineage: the node model (contribution | region), its DOM attribute grammar, the portal-crossing chain helpers, the <UiRegion> producer, the collectLineage walk, and the <ui-context> token (collectMeta / serialize / parse). A neutral leaf so both the element picker (its element-picker sub-plugin) and reports/render-loop can ask 'what composed this element?' without either depending on the other.
- Web:
  - Uses:
    - `primitives/css/ui-kit.PortalForwardProvider`
    - `primitives/css/ui-kit.usePortalForwardedAttrs`
  - Exports (types):
    - `ContributionNodeAttrs`
    - `RegionNodeAttrs`
  - Exports (values):
    - `appendLineage`
    - `BOXLESS_ATTR`
    - `collectLineage`
    - `collectLineageMeta`
    - `collectMeta`
    - `contributionNodeAttrs`
    - `isBoxlessMarker`
    - `LINEAGE_ATTR`
    - `nearestOwner`
    - `nearestSource`
    - `NODE_ATTR`
    - `readLineageNode`
    - `regionNodeAttrs`
    - `UiRegion`
- Cross-plugin:
  - Imported by:
    - `apps/website/improve`
    - `layouts/full-pane`
    - `layouts/miller`
    - `primitives/adaptive-bar`
    - `primitives/error-boundary`
    - `primitives/ui-context/element-picker`
    - `reports/crash`
    - `reports/render-loop`
- Core:
  - Exports (types):
    - `ContributionNode`
    - `ElementDescriptor`
    - `LineageNode`
    - `RegionNode`
    - `UiContextField`
    - `UiContextLabel`
    - `UiContextMeta`
    - `UiContextProvenance`
    - `UiContextSegment`
  - Exports (values):
    - `formatElementDescriptor`
    - `formatLineageNode`
    - `formatLineagePath`
    - `parseElementDescriptor`
    - `parseLineageNode`
    - `parseLineagePath`
    - `parseUiContext`
    - `serializeUiContext`
    - `splitUiContext`
    - `UI_CONTEXT_FIELDS`
    - `UI_CONTEXT_RE`
    - `uiContextLabel`
    - `UiContextMetaSchema`
- Test helpers:
  - Web: `@plugins/primitives/plugins/ui-context/web/testing`
    - `parseLineage` — Parse a serialized lineage back into nodes (outer→inner).
- Sub-plugins:
  - **`element-picker`** — Chrome-inspector-style element picker: <ElementPicker> arms a full-screen overlay, the user hovers and clicks any element, and onPick receives its <ui-context> metadata (plugin/slot lineage…

<!-- AUTOGENERATED:END -->
