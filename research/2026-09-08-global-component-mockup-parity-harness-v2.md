# Component mockup ⇄ parity — v2: the interactive compare surface

Supersedes the sequencing in
[`2026-08-28-global-component-mockup-parity-harness.md`](./2026-08-28-global-component-mockup-parity-harness.md).
The gap analysis in v1 still stands; **the ordering does not**.

## Context

v1 assumed the mockup would be authored in the repo beside the component and measured
in the same document, and it sequenced the automated headless sweep first. The user
settled the open question differently:

- **Mockups stay prototypes.** A prototype's freedom from every app constraint —
  separate document, outside the repo, blank template, no access to plugins or
  tokens — is the point, not a compromise. *"The goal is then to adapt."*
- **Two live renderings, side by side, both interactive:** the prototype mock (can be
  anything) and the real component (the app's own React).

That reframing removes most of what v1's steps 1–3 were building:

| v1 step | Status under v2 |
|---|---|
| Screenshot the standalone Vite/Playwright page | **Later.** Automation, not looking. |
| Resolve theme CSS purely for that page | **Later, and mostly moot** — a component rendered *inside* the app is already themed. |
| Theme switcher in the Layout Lab gallery | **Later.** |

It also removes a discipline v1 had to impose by hand. v1 said "author the mock in
free CSS, never app utilities, or the diff is trivially green." The prototype system
already enforces exactly that, structurally, in a place nobody can forget it — rung 1
instead of rung 5.

## What each half already is

**The mock half is done.** `ScaledIframe`
([`gallery/web/components/scaled-iframe.tsx`](../plugins/apps/plugins/prototypes/plugins/gallery/web/components/scaled-iframe.tsx))
mounts a prototype at its declared viewport, scaled to fit, cache-busted by the
`prototypes.version` resource so an agent's edit reloads it live. It is interactive,
and it runs `allow-same-origin` from our own origin — so the host page can reach
`contentDocument` and read computed styles and rects. **Cross-document measurement
stays possible**, which is what keeps v1's measured gap table reachable later.

**The component half is done too.** The Layout Lab
([`layout-harness/web/internal/gallery.tsx`](../plugins/primitives/plugins/css/plugins/layout-harness/web/internal/gallery.tsx))
already renders real fixtures live and interactive, in-app, one `PluginErrorBoundary`
per cell. A fixture is exactly *"a real component in a known state"* — the counterpart
a mock wants.

**Nothing joins them.** The prototype detail pane's Focus | Compare switch compares
prototypes *to each other*, and its mode set is a closed union with no extension point.

## Design

### The stage set becomes a slot

Today `PrototypeViewMode = "focus" | "compare"` is a union in
[`gallery/web/context.tsx`](../plugins/apps/plugins/prototypes/plugins/gallery/web/context.tsx),
its options a literal `MODE_OPTIONS` array in `detail-actions.tsx`, and the branch a
ternary in `prototype-detail.tsx`. Three files must change to add a mode, and the
gallery would have to import `layout-harness` to host a component stage.

Make the stage set a slot instead — `PrototypeStage` (`id`, `label`, `component`).
The gallery renders its switcher from the contributions and paints the active one,
naming no mode. Focus and Compare become the gallery's own two contributions.

This is the load-bearing choice, and it earns itself twice: the mode set is genuinely
open now, and **comparing against a live app component becomes an optional plugin**
rather than a coupling baked into the gallery. It is the only mode that ties
prototypes to app internals, and it should be the only thing that carries that weight.

### A prototype names its counterpart in its own HTML

Prototypes hold every piece of metadata in the document — `<title>`, `<meta
name="description">`, `<meta name="prototype-viewport">` — parsed by `HTMLRewriter` in
[`files/shared/list-metas.ts`](../plugins/apps/plugins/prototypes/plugins/files/shared/list-metas.ts),
with no sidecar file. So:

```html
<meta name="mocks" content="breadcrumb/overflow" />
```

The value is a **fixture id**. That reuses the existing catalog whole: already
collected from every contributing plugin, already renders live, no second registry and
no new contribution mechanism.

**The conflation to accept knowingly:** fixtures exist to gate geometry, carrying
`data-geo` marks and invariants. Reusing them as the component catalog gives them a
second job. It is the right trade for now — a fixture *is* the state you want to
compare — but if the sets diverge (a component worth mocking that no fixture covers),
that is the signal to split them.

### Consequence worth stating up front

Prototypes are host-global and outside git; fixtures are per-worktree and versioned.
So a pairing can never be checked at build time. A prototype naming a fixture that
does not exist in this worktree shows "no counterpart" and that is all it can do. The
binding is a runtime lookup, not a typed reference.

---

## The steps

### 1. Turn the prototype stage set into a slot

Add `PrototypeStage` to the gallery plugin (new `web/slots.ts`, mirroring how
`prototypeDetailPane.Actions` already lets a sibling add a header control). Contribute
`focus` and `compare` from the gallery itself. `context.tsx` holds the active stage id
as a `string`, not a union; `detail-actions.tsx` builds its `SegmentedControl` options
from the contributions; `prototype-detail.tsx` renders the active stage's component
instead of a ternary.

**Nothing changes on screen.** That is the point — it is verifiable by the pane
behaving exactly as before.

Files: `gallery/web/{slots.ts,context.tsx,index.ts}`,
`gallery/web/components/{detail-actions.tsx,prototype-detail.tsx}`.

### 2. Let a prototype declare what it mocks

Add `mocks` to `PrototypeMeta`: one more branch in the `meta` element handler in
`parseHtmlMeta`, one more field on the local `HtmlMeta`, one more key on
`PrototypeMetaSchema` (required on the wire with `""` supplied by `readMeta`'s `base`,
exactly as `blurb` already works), and the doc comment on the schema listing it beside
the other three tags.

Document the tag in [`prototypes/CLAUDE.md`](../prototypes/CLAUDE.md) under "The three
metadata tags" — which becomes four. Note there that it is optional and that most
prototypes will not have it.

**Verify:** `./equin prototype list` and the `prototypes.list` resource carry the
field; a prototype with no tag reports `""`.

Files: `files/core/prototypes.ts`, `files/shared/list-metas.ts`, `prototypes/CLAUDE.md`.

### 3. The compare-component stage

New sub-plugin `plugins/apps/plugins/prototypes/plugins/compare-component/`,
contributing one `PrototypeStage`. It reads the open prototype's `mocks` field,
resolves it against `loadFixtures()` from
`@plugins/primitives/plugins/css/plugins/layout-harness/core`, and paints the mock
iframe and the live component side by side **at a shared width**, both interactive.

Shared width is the whole comparison affordance — one control that resizes both halves
together, so the question is always "at this width, do these agree?"

Three states to render, none of them an empty box: the prototype declares no
counterpart; it declares one this worktree does not have; it declares one that exists.
Wrap the component half in `PluginErrorBoundary` so a throwing fixture costs its half
and not the pane.

**Verify:** mint a prototype, tag it `breadcrumb/overflow`, open the pane, resize, and
interact with both halves.

Files: new plugin (`web/{index.ts,slots.ts,components/}`, `package.json`, `CLAUDE.md`).

---

## What this defers, and what it does not cost

Deferred: the headless screenshot sweep, `resolveThemeCss` and the standalone page's
theming, and the measured gap table.

Not lost: the same-origin iframe keeps cross-document measurement available, so the
gap table remains reachable from this surface. When it comes, it needs `data-mock="…"`
marks on the mock's boxes — the mirror of `data-geo` — since a prototype is a page and
nothing otherwise says which box is the counterpart.

## Verification

- `./equin check` — the boundary and plugin-doc checks are the ones step 1 and 3
  can trip.
- `./equin build`, then the Prototypes app: the Focus and Compare stages must
  behave exactly as before step 1 changed nothing visible.
- A minted prototype tagged with a real fixture id, opened in the new stage.
- `./equin test plugins/primitives/plugins/css/plugins/layout-harness` — untouched
  by this plan, but it is the gate that proves the fixture catalog still loads.

## Open

- **Where the width control lives** — shared across both halves (assumed), or each
  half independent with a "link" toggle.
- **Whether the component half should offer the fixture picker** when a prototype
  declares no counterpart, or stay strictly declarative. Assumed: strictly declarative,
  so the prototype is always the source of the pairing.
