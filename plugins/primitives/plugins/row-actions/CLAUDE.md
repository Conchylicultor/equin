# row-actions

## The ONLY row-action cluster in the app

Every hover-revealed trailing action cluster renders through `RowActions`. Hosts
own **placement only** — never a reveal. Placement is a closed set:

| Host shape | Call |
|---|---|
| Row / tree row (overlays trailing edge) | `<RowActions>` (pins `right`) |
| Gallery card (hover cluster) | `<RowActions pin="top-right">` |
| Gallery card footer (actions that live at rest) | `<RowActions pin={null} alwaysVisible>` |
| Table (reserved `auto` grid track) | `<RowActions pin={null}>`, persistent twin `pin={null} alwaysVisible` before it |
| Beside prose (a headerless transcript turn) | `<RowActions pin={null} float>` — the text wraps around it |

`alwaysVisible` is **per-cluster by design** — a cluster either fades or doesn't.
Which cluster a given action belongs to is the *action's* call, declared once as
`data-view`'s `ItemActionContribution.zone`; a view then paints at most one
cluster per zone. Don't reach for a per-action `alwaysVisible` here.

`pin`/`float` are a discriminated pair: a pinned cluster is out of flow, so
only an unpinned one can take part in a text flow. A cluster beside prose
floats rather than overlaying it — an overlay over text hides the words under
it whatever chrome it paints. The `--scrim` obligation on the host applies
**only when pinned**.

Enforced by `row-actions/no-raw-actions-slot` (this plugin's `lint/`): an
`actions`-shaped prop must *reach* `RowActions` — as its child or forwarded as
an `actions=` attribute. Deliberately a **dataflow** rule, not a class-shape
one: a shape rule describes today's reveal mechanism, so a duplicate using a
different one satisfies it in place (which is how the tree's `w-0` cluster
survived `no-uncoupled-hover-reveal` in `ee2dfe424`).

`hover-reveal` still owns *single* affordances (a tab's `×`, a block's controls)
and nested reveal scopes, where per-instance JS state beats a shared CSS group.
Boundary: **an action cluster on a row/card/table row is this plugin, not that.**

## This plugin owns no button — put plain `IconButton`s in the cluster

The cluster applies `ControlSizeProvider size="xs"` to its children, so an action
button is an ordinary `IconButton` and needs no wrapper. **Do not add a
`RowActionButton` alias back.** It reads as a harmless convenience, but it drags
`icon-button` (and through it `action-presentation`) into this barrel — and
`css/row` composes this plugin, so the alias is what pushes `Row`, a *layout*
primitive, above `IconButton` in the graph. Everything `IconButton` renders is
then forbidden from using `Row`.
`research/2026-08-17-global-row-usable-below-icon-button.md`.

## Reveal: row hover, or keyboard focus INSIDE the cluster

`has-[:focus-visible]`, never `group-focus-within/row-actions` — **the row's own
focus must not count.** Clicking a row focuses something inside it on every
surface (a `CollapsibleCard` toggle, `ContentScope`'s `tabIndex={-1}` div, an
inline file link, a tree chevron, `Row`'s primary button), so a row-scoped focus
reveal leaves the actions on screen after the pointer leaves.

- **`has-[…]`** asks about the cluster: `:has()` matches descendants only, and
  these classes ride the outermost node the primitive renders (the `Pin`, or the
  `Stack`/`Surface` when `pin={null}`), which holds exactly the action buttons.
- **`:focus-visible`** keeps it keyboard-only — Chromium doesn't mark a
  mouse-clicked button focus-visible, so clicking an action doesn't pin its own
  cluster either; Tab always does.

`opacity-0`/`pointer-events-none` leave a button in the tab sequence, so tabbing
into the cluster reveals it in the same tick. Design:
`research/2026-08-07-global-row-action-click-pinning.md`.

## A pinned hover cluster mounts when its row is reached

A list mounts N rows at once (a group unfolding, a page of results), and a hover
cluster is the bulk of what a row costs — a handful of `IconButton`s, each a
tooltip root, often a reorder area of its own — for buttons nobody can see yet.
So a **pinned, hover-revealed** cluster renders only a hidden sentinel until its
row is *reached*, then mounts its buttons and keeps them:

- **pointer** — `pointerover` / `pointermove` on the anchor (`move` covers a row
  that mounted under a resting pointer), or the anchor already `:hover`;
- **focus** — `focusin` anywhere in the anchor. Tab lands on the row's own
  control first, which mounts the cluster just after it in the sequence.

Two cases mount at once, exactly as before: a row with **no focus stop of its
own** (a plain container row — Tab could only ever land on the actions
themselves), and a cluster with **no `rowActionsAnchor` above it** (nothing would
arm it). An **in-flow** cluster (`pin={null}`, a table's reserved track) and an
**`alwaysVisible`** one never wait: the first sizes its track by its content,
the second is on screen at rest.

A test reaching for a hover action does what a user does first —
`fireEvent.pointerOver(<something in the row>)` — before querying it.

## The reveal is opacity-only, never layout

The cluster is pinned, so it reserves no flow width and its geometry is identical
hovered or not. Load-bearing: a dropdown launched from inside the cluster
**anchors to it**, so a layout-changing reveal moves the anchor and slides the
open menu sideways when the row loses hover. **This is the one hover-revealed
row-action implementation** — don't hand-roll a second (the tree's old `w-0`
cluster was exactly that). Design:
`research/2026-08-06-global-row-action-anchor-stability.md`.

Two consequences for the host row:

- It must co-publish `--scrim` alongside **every** background tint it paints
  (`hover:bg-accent hover:[--scrim:var(--accent)]`, selected, drop-target …),
  like `css/row` does — that is the colour `Pin mask` paints behind the buttons
  so the label/badge they overlay dissolves. Missing it makes a hovered row read
  as a hole.
- The reveal classes ride the **outermost** node (the `Pin`, when pinned): the
  scrim is opaque, so fading only the buttons would hide the row's trailing
  content at rest and park a live click-target over the row. The
  click/pointerdown guards stay on the inner cluster instead, so a press on the
  scrim's fade margin still reaches the row.

An open popup inside the cluster holds it revealed, via `<PopupOpenScope>`
(`primitives/overlay/popup-open`) — a typed React signal, deliberately not a
`has-[[data-popup-open]]` CSS selector naming another library's attribute
contract (that spelling silently rotted once). Geometry is stable by
construction; *visibility* rests on this signal, and only the runtime asserts it:
`apps/pages/page-tree/e2e/row-actions-overflow.ts`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Hover-revealed row-action cluster: a row of ordinary IconButtons revealed when their row is hovered/focused. The primitive owns the reveal (opacity↔pointer-events coupled, so a hidden action is never a live click-target), the right-edge Pin positioning, and the icon-xs sizing it applies to its children — so it ships no button of its own and stays BELOW icon-button, which is what lets css/row compose it. Reveal is driven by the primitive's own `group/row-actions` group, applied to the row via the exported `rowActionsAnchor` class — so it never piggybacks on a consumer's group name.
- Web:
  - Uses:
    - `primitives/css/pin.Pin`
    - `primitives/css/pin.PinAnchor`
    - `primitives/css/spacing.insetClass`
    - `primitives/css/spacing.Stack`
    - `primitives/css/ui-kit.cn`
    - `primitives/css/ui-kit.ControlSizeProvider`
    - `primitives/overlay/popup-open.PopupOpenScope`
  - Exports (types): `RowActionsProps`
  - Exports (values):
    - `RowActions`
    - `rowActionsAnchor`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by:
    - `conversations/conversation-view/jsonl-viewer`
    - `conversations/conversation-view/jsonl-viewer/row-actions`
    - `page/sub-page`
    - `primitives/breadcrumb`
    - `primitives/commit-list`
    - `primitives/css/control-panel`
    - `primitives/css/row`
    - `primitives/data-table`
    - `primitives/data-view`
    - `primitives/data-view/gallery`
    - `primitives/tree`
    - `shell/health-report`

<!-- AUTOGENERATED:END -->
