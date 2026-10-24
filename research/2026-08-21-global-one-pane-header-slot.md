# One pane header slot

Collapse the two rival pane-header systems into ONE reorderable, overflow-collapsing
render slot per header. No `position` field, no `chrome.header`, no `pane-toolbar`.

## Context

A pane's header can be filled two ways, and picking one forces two unrelated
choices you did not intend to make.

1. **`pane.Actions`** — auto-minted per pane by `Pane.define`
   (`plugins/primitives/plugins/pane/web/pane.ts:2080`). Contributions carry
   `position: "left" | "right"`; the right cluster is an `AdaptiveBar` that
   collapses into `⋯` when the column is narrow.
2. **`chrome: { header }`** — a `definePaneToolbar()` pair of `Start`/`End`
   render slots (`plugins/primitives/plugins/pane-toolbar/`). Reorderable, but by
   design there is NO overflow collapse, and the pane title stops being chrome and
   must be re-contributed.

Both render inside the same `<Bar tier="pane">`, through the same `ToolbarItem`
renderer, in the same two positions. Today you cannot ask for "reorderable AND
collapsing", which is what an ordinary pane wants.

Three things have changed since that split was made, and together they are why
this is now doable:

- **Slots name themselves at runtime** (`e247da754`, design:
  `research/2026-08-20-global-slot-naming-witness.md`). The reorder manifest is
  derived from declarations, not from a source-text scan, so a slot whose id is
  built at run time — `` `<plugin>.<pane>.actions` `` — is in it. It already is:
  106 pane-actions slots are in `plugins/reorder/shared/reorderable-slots.generated.ts`.
  The precondition this task was waiting on has landed.
- **`adaptive-bar` exists** — overflow as relocation, not transformation. A
  relocated slider is the same live instance, mid-gesture. Every policy comes
  from the widget via `action-presentation`'s `useActionForm`, so the host names
  no contributor.
- **The reorder tree has node types** — `spacer` (a `flex-1` gap) and `overflow`
  (an authored `⋯` bucket), both first-class, both already authorable in config.

### What today actually costs

- `pane.Actions` **is** a `defineRenderSlot` and **is** in the reorder manifest,
  but `PaneActionsSlot` (`pane-chrome.tsx:300`) renders it through
  `useContributions()` + `renderIsolated` instead of `.Render` — because it has
  to filter on `position`. `.Render` is what applies the reorder LIST middleware.
  So every pane header owes a config directive it never reads: **ordering,
  hiding and spacers are silently ignored on all 106 of them.** The `position`
  field is what put them there.
- Every `chrome.header` pane *also* carries a dead auto-minted actions slot with
  its own config directive: `apps.website.shell.website-landing.actions`,
  `apps.sonata.library.sonata-player.actions`,
  `apps.story.shell.story-detail.actions`, plus the three website pillars and
  downloads. Six directives that render nothing.
- The wart is written down in the config itself
  (`config/apps/prototypes/gallery/prototypes-detail.actions.jsonc`): *"`view-mode`
  is contributed with position: "left", so it sits just after the title
  regardless of its place here"*.

### Migration size (verified, not the stale numbers)

- `definePaneToolbar` call sites: **3** — story, sonata, website (the prototypes
  one is already gone).
- Panes wired via `chrome: { header }`: **7** — story×1, sonata×1, website×5.
- Contributions into those zones: **16**.
- Cross-plugin `pane.Actions` contributions: **5** across 3 panes
  (`conversations/agents`, `apps/events/.../refresh-all`, `apps/prototypes/gallery`×2,
  `apps/prototypes/present`).
- `position: "left"` users: **1** (`apps/prototypes/gallery` → `view-mode`).

## End state

One `defineRenderSlot<PaneHeaderItem>` per header, rendered by one `AdaptiveBar`
that is the header row's grow cell:

```
<Bar tier="pane">
  {leadingControl}
  <AdaptiveBar gap="xs" label="More actions" align="end">
    <pane.Actions.Render>{(item) => <PaneHeaderCell {...item} />}</pane.Actions.Render>
  </AdaptiveBar>
  {promote}{close}
</Bar>
```

- **No `position`.** A `spacer` node in the slot's config separates the leading
  group from the trailing one.

  > **Correction (found in Phase B).** The plan first claimed `align="end"` alone
  > preserves today's layout. It does not, and only a title-less pane made it look
  > like it did. Today the title is a direct `Bar` child and the `AdaptiveBar`
  > (`flex-1`) eats the slack *after* it — title left, actions right. Move the
  > title inside as a non-growing cell and `justify-end` packs it right too,
  > against the actions: a visible regression on all 106 panes unless every one
  > gets a spacer directive, which is exactly the seeding this plan rules out.
  >
  > So the title's cell **gives and grows** (`min-w-0 flex-1` — a `Fill`). The
  > slack then sits between the title and the actions, which is today's layout
  > exactly, and an empty growing cell absorbs it so a title-less header lands
  > pixel-identically. `align="end"` still governs when there is no title at all.
  > The fit math is untouched: `flex: 1 1 0%` contributes no width and `min-w-0`
  > surrenders first.
  >
  > Consequence, accepted rather than engineered around: a growing title and an
  > authored spacer are two grow cells and split the slack between them. So a pane
  > that wants a *second* split point puts the affected items in the trailing
  > group instead. Sonata is the only such pane — its display picker joins the
  > trailing cluster rather than sitting beside the title. We are not adding a
  > conditional "the spacer suppresses the title's grow" rule for one pane; if it
  > reads badly, that is a separate question.
- **The title is a contribution**, minted by the pane itself so no author
  re-contributes it, and rendered in a **yielding** cell — the one bar child that
  is excluded from the fit ledger and may shrink. That is what lets it ellipsize
  exactly as it does today while being orderable and hideable like anything else.
- **Collapsing is generic.** Whatever does not fit relocates into the `⋯` panel
  as itself. No never-collapse policy is added — widgets already have
  `useActionForm({ yields })` if an author wants one, and per this task's scope we
  add nothing on top.
- **A pane may borrow another's slot**: `Pane.define({ actions: WebsiteHeader })`.
  `pane.Actions` then IS that slot. One slot type, one renderer, one directive.

## The three primitive changes this needs

These are the load-bearing part. Everything else is mechanical.

### 1. `adaptive-bar` must dock against the anchor's parent, not the bar root

`dockInline` (`adaptive-bar/web/internal/relocate.ts:138`) does
`root.insertBefore(container, anchor)`. That requires the anchor to be a **direct
DOM child of the bar root**. It is why `PaneActionsSlot` renders a bare fragment
today, and why nothing in the repo composes `<Slot.Render>` inside `<AdaptiveBar>`
even though `adaptive-bar/CLAUDE.md` documents exactly that as the pattern.

Between a bar and a contribution rendered through `.Render` sit three wrappers —
`slot-render`'s `ContributionBox`, reorder's `SortableItem`, and its content
wrapper. In non-edit mode the last two are `display: contents`, which removes them
from *layout* but not from the *DOM tree*, so the anchor is 2–3 levels down and
the insert throws.

Fix, in `adaptive-bar`:

- dock with `anchor.parentNode.insertBefore(container, anchor)`. The anchor is
  already the truth about position; the root was an assumption. Through a
  `display: contents` chain the container is still a flex item of the bar root, so
  gap and measurement are unchanged.
- move `shrink-0` off the root's `[&>*]` selector (`BAR_ROOT`,
  `adaptive-bar.tsx:169`) and onto each minted container. The parent selector only
  reaches direct children; through a contents chain it would stop reaching the
  containers, and a squeezable occupant is the proven blind-the-guard failure
  (`fixtures/` → `adaptive-bar/squeezable-occupants`, 186px → 83px).

**Report this as a footgun regardless of this task**: the documented composition
is currently broken, silently, for anyone who follows the CLAUDE.md example.

### 2. `slot-render`: the host may own the item box

`ContributionBox` (`slot-render/web/internal/render-slot.tsx:82`) draws a
`flex min-w-0 items-center` cell whenever it measures a horizontal host. Inside a
bar that is a second, competing flex item beside the container the bar mints —
the bar's container IS the occupant's box.

Add a `SlotItemLayout` value meaning *the host draws each item's box* (alongside
today's `"row"` / `"column"`), and have `AdaptiveBar` declare it around its
children. `ContributionBox` then takes its existing boxless branch —
`display: contents` + `boxless: true` attrs — which is byte-for-byte what
`renderIsolated` produces today. Files:
`slot-render/web/internal/item-layout.tsx`, `render-slot.tsx`,
`adaptive-bar/web/internal/adaptive-bar.tsx`.

### 3. `adaptive-bar` gains a yielding child

At most one child per bar that is **excluded from the ledger** — never measured,
never demoted, never relocated — and given `min-w-0` instead of `shrink-0`, so it
absorbs the leftover and its inner `<Text>` truncates.

An unregistered child is already invisible to the bar's math (it reads registered
containers' rects), so this is mostly an escape from the blanket `shrink-0` plus a
spelling: `<AdaptiveBar.Yield>`. Enforce at-most-one loudly, the way the spacer's
"at most one per slot" is stated.

The `spacer` node is the same family with the other half of `Fill`: it grows and
does not shrink, and needs no change — `flex-1` under `[&>*]:shrink-0` is already
grow-only, and grow-only can never fall below its (empty) content, so the fit's
sum-of-occupants is untouched. Name them off the existing vocabulary
(`primitives/css/yield`, `primitives/css/grow`).

## Plan

### A. Primitives

1. `adaptive-bar`: dock against the anchor's parent; `shrink-0` onto the
   container. Add `AdaptiveBar.Yield`.
2. `slot-render`: host-owns-the-box layout value; `AdaptiveBar` declares it.
3. Extend the two `__tests__` that pin this: `relocation.test.tsx` (dock through a
   `display: contents` wrapper chain) and `row-inset.test.tsx` (a yielding child
   does not enter the budget).

### B. `pane`

Files: `pane/web/pane.ts`, `pane/web/components/pane-chrome.tsx`,
`pane/web/components/pane-header-item.tsx`, `pane/web/index.ts`, `pane/CLAUDE.md`.

4. **One contribution type.** Merge `PaneActionContribution` and
   `PaneToolbarItem` into `PaneHeaderItem`:
   `{ id; component?; label?; icon?; onClick?; cell?: "yield" }`. Drop `position`.
   `ToolbarItem` becomes the single `PaneHeaderCell` renderer. `cell` is public and
   generic — at most one per slot — so the title is not a special case.
5. **`Pane.define({ actions })`.** When given, `pane.Actions` IS that slot and no
   slot is minted; when omitted, mint as today. Export
   `definePaneHeaderSlot()` from `pane/web` for shared headers (owns `docLabel`
   and the `controlSize` baseline `definePaneToolbar` used to).
   A borrowing pane is simply not listed in its plugin's `slots:` record — the
   shared slot is declared once, by its owner, so the one-declarer rule holds.
6. **The title becomes a contribution.** Follow `reorder`'s existing precedent
   exactly (`reorder/web/internal/config-registrations.ts`): a module-level
   `Contribution[]` that `pane`'s barrel exposes, filled via
   `subscribeSlotsDeclared` with one `{ id: "title", component: PaneTitleItem,
   cell: "yield" }` per distinct pane-header slot (de-duped by slot identity, so a
   borrowed slot gets exactly one). Entry key is `primitives.pane:title` in every
   header's catalog.
   `PaneTitleItem` reads the pane's already-resolved title (the `title` prop or
   `chrome.title`) off a context `PaneChrome` publishes, and renders `null` when
   there is none — the bar reads that as absent, so a title-less pane costs no gap.
   Authoring is unchanged: `chrome.title` / `<PaneChrome title={…}>`.
7. **`PaneChrome`** renders the one bar shown above. Delete the `CustomHeader`
   branch, `PaneHeaderZones`, and the `position` filter. `hideRightActions` and the
   per-instance `actions` (`pane-extra`) prop keep working — they are host-level,
   not part of the rivalry.

### C. Delete `pane-toolbar`

8. Remove `plugins/primitives/plugins/pane-toolbar/` entirely. Move its
   `no-adhoc-pane-toolbar` lint rule to `plugins/primitives/plugins/pane/lint/`,
   retargeted at the pane header slot. Update `bar/lint/no-adhoc-bar.ts`, which
   names `definePaneToolbar` in its message.

### D. Migrate the 7 toolbar panes

9. **Sonata** (`apps/sonata/plugins/library`, `shell/web/slots.ts`): drop
   `SonataToolbar`; `sonataPlayerPane.Actions` takes its 10 contributions. Move
   `config/apps/sonata/shell/{start,end}.jsonc` into one
   `config/apps/sonata/library/sonata-player.actions.jsonc` = leading items,
   `{"type":"spacer"}`, then the End order verbatim.
10. **Story** — same shape, 3 contributions, 1 pane.
11. **Website** — the shared case: `definePaneHeaderSlot()` in
    `apps/website/plugins/shell/web/slots.ts`, and all 5 panes take
    `Pane.define({ actions: WebsiteHeader })`. The wordmark is a fixed-size logo,
    so it is an ordinary occupant; a spacer sits between it and the nav. Merge
    `config/apps/website/shell/{start,end}.jsonc` into one file.
12. **Prototypes**: delete `position: "left"` from `view-mode` and put a spacer
    after it in `config/apps/prototypes/gallery/prototypes-detail.actions.jsonc`.
    Rewrite that file's comment, which currently documents the wart.

### E. Config + docs

13. **Not** through `slot-id-rename.json`. That table + its one-shot
    `codegen/scripts/slot-config-rename.ts` express a same-directory 1:1 *rename*
    of a user-layer file, and it asserts on two slots targeting one name. What
    this migration does is a **merge across directories**: `apps.sonata.shell.start`
    + `apps.sonata.shell.end` become one
    `config/apps/sonata/library/sonata-player.actions.jsonc`, and likewise for
    story and website. So:
    - hand-author the merged committed files (leading items, `{"type":"spacer"}`,
      then the End order verbatim) and delete the old `start`/`end` ones;
    - the four borrowed website panes' own `.actions` slots stop existing;
    - `./equin build` regenerates `reorderable-slots.generated.ts` and every
      `.origin.jsonc`. `reorderable-slots-in-sync` and `config-origins-in-sync`
      are the gates.
    - user-layer leftovers (`~/.singularity/config/<worktree>/…`) are not carried
      by any commit; they surface in Debug → Config orphans
      (`plugins/debug/plugins/config-orphans`), which is the right place for them.
14. Update `pane/CLAUDE.md` (the whole "Custom header (`chrome.header`)" section,
    plus "When the header runs out of room"), `adaptive-bar/CLAUDE.md` (the dock
    rule and the new yielding child), `slot-render/CLAUDE.md`, and the three app
    `CLAUDE.md`s that name `definePaneToolbar`.

## Verification

- `./equin build` — the gate. `reorderable-slots-in-sync`,
  `config-origins-in-sync`, `plugins-registry-in-sync`, `plugins-doc-in-sync`,
  `plugin-boundaries`, `type-check` all have to pass, and the first two are
  precisely what a missed config rename trips.
- `./equin test plugins/primitives/plugins/adaptive-bar` and
  `plugins/primitives/plugins/slot-render` — the docking and box changes.
- `bun plugins/primitives/plugins/adaptive-bar/e2e/adaptive-bar-relocate.ts`
  and `adaptive-bar-churn.ts` against the deployed worktree — relocation still
  preserves the live instance now that docking anchors differently.
- `bun plugins/reorder/e2e/claim-verify.ts` — reorder still claims header items.
- By hand at `http://<worktree>.localhost:9000`:
  - narrow a conversation column → trailing actions fold into `⋯`, the title
    ellipsizes rather than pushing them out;
  - the Sonata player (`/sonata`, open a song) → back + title + display picker
    lead, transport/volume/jog-wheel trail, and the volume slider is still
    draggable after it relocates;
  - the website's 5 panes all show the same nav from one slot;
  - toggle the reorder pen (`reorder/edit-mode`) on a pane header → items drag,
    hide and restore, which is what has silently not worked on any of the 106
    pane headers until now.

## Out of scope

- No never-collapse policy (`yields: "never"` hard pin, or an authored `overflow`
  bucket per pane). If a collapsed Sonata transport reads badly, that is a
  separate question about how to make it cleaner.
- The `adaptive-bar` docking bug is fixed here because this task needs it, but it
  should also be reported on its own: the composition its own CLAUDE.md documents
  throws today.
