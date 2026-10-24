# `ControlPanel.Subhead` — the label that names a run of rows inside a band

## Context

A DataView's field schema can be contributed to by several plugins. The merged
run surface is the case that forced it: base columns every arm projects, plus one
band per arm (Build / Backup / Release / Deploy). `FieldDef.section` and the
shared `FieldSections` component now draw every "choose a field" surface band by
band — the filter and sort typeahead, the Properties list, the group-by band —
so forty columns read as five short lists instead of one flat one.

The heading those bands are drawn with is hand-rolled typography:

```tsx
// plugins/primitives/plugins/data-view/web/internal/field-sections.tsx
function FieldSectionHeading({ children }) {
  return (
    <Text as="div" variant="caption" tone="muted" className="px-2xs pt-xs pb-2xs">
      {children}
    </Text>
  );
}
```

Two of the three surfaces it renders into are `ControlPanel` bodies, whose rows
are `ControlPanel.Row` and whose band titles are `ControlPanel.Section`. So the
rows come from the vocabulary and the heading above them does not. Consequences,
in order of how much they matter:

1. **It is not governed.** If the panel's label rails or typography change, this
   heading does not follow. The three surfaces look alike today only because one
   shared component draws them.
2. **It is already 4px wrong.** `px-2xs` puts it past the panel's published rail
   — aligned with neither the `Section` eyebrow above it (on the rail) nor a
   row's leading cell. `useRailGuard` does not catch it because the heading is a
   grandchild of the panel root, not a direct child.
3. **The vocabulary has a hole and says so.** `control-panel/lint/index.ts`
   records that a body built from `Stack` + a label + rows with no divider is
   invisible to `no-adhoc-panel-body`. This is exactly that shape.

The panel has no member for "a label naming a run of rows inside one band".
`Section` is a band (its `cp-band` hairline would rule between a heading and the
rows it names). `Group` is a field that is other fields (it drills or indents).
`Block` is a control wider than a row. This plan adds the missing rung.

**Outcome:** one member, `ControlPanel.Subhead`; `FieldSections` renders it; the
heading is on the panel's own rail, gated by a geometry fixture.

## The decisions, and why

**A bare label, not a container.** `Subhead` takes `children` and renders one
line; the author places it before the run. `Section` and `Group` are containers
because each declares a box property (`cp-band`, `cp-group`); a sub-head declares
none — no band, no rail, no track. The decisive reason is layout neutrality: the
three hosts `FieldSections` renders into are two `cp-band` divs (block flow, no
gap) and one `Stack gap="2xs"` (flex). A bare label composes into all three
unchanged; a container would pull the rows out of that `Stack`'s flex context and
have to re-invent the intra-run spacing the surface already owns. `Empty` is the
precedent — a pure in-band label member, placed as a sibling.

The orphan case ("a heading pointing at nothing") is already prevented upstream
where it belongs: `FieldSections` emits a heading only when `sections.length > 1`,
over sections that by construction hold fields.

**Caption/muted, on the icon rail.** Typography stays exactly what ships:
`variant="caption" tone="muted"`. A second small-caps eyebrow directly under a
`Section`'s reads as a peer band rather than a child of it, and the vocabulary
already has this third rung for in-band non-row text (`SettingNote`,
`SettingDescription`, `Section`'s `description`, `Empty`) — reuse it rather than
mint a fourth. The rail changes: **drop `px-2xs`**, so the heading lands on the
panel's content edge by carrying no class, the same way the eyebrow above it and
every loose control do. It names a RUN, which is the eyebrow's side of invariant
#1's split, not a field label's.

**The bare popover needs no change.** `field-picker.tsx` (changing an existing
filter rule's field) mounts `FieldSearchList` in an `InlinePopover` with no
`cp-panel` ancestor. The member is correct there by construction: it carries no
`cp-*` and no rail class, so it lands on whatever region hosts it — that is the
*inherit* half of the rail contract. Promoting that popover to a
`ControlPanelPopover` is a separate change (`FieldSearchList` draws `css/row`
`Row`s, whose own `p-row` inside a rail region is the double-inset the guard
exists to name) and is explicitly **not** in scope.

## Steps

### 1. New member — `control-panel/web/internal/subhead.tsx`

Template: `block.tsx` (plain presentational function, reads no context — only
`Group` reads `useControlPanelHost()`).

```tsx
export interface ControlPanelSubheadProps {
  /** The run's name — "Common", "Build", "Deploy". */
  children: React.ReactNode;
  className?: string;
}

export function ControlPanelSubhead({ children, className }: ControlPanelSubheadProps) {
  return (
    <Text as="div" variant="caption" tone="muted" className={cn("pt-xs pb-2xs", className)}>
      {children}
    </Text>
  );
}
```

Doc comment in house style — what it is, then what it is deliberately **not**:
not a `Section` (no `cp-band`; a rule between a heading and its own rows is the
inverse of what a heading is for — same reason `RuleList`, `Empty` and `Block`
are not bands); not an eyebrow (a second small-caps line under one reads as a
peer band); not a field label (that rung names ONE control and is drawn in a
row's label cell on the text rail). Record the asymmetric padding's reason: more
above separates the run from the previous run's last row, less below binds the
heading to the rows it names.

**No new CSS.** `pt-xs` / `pb-2xs` are existing ramp tokens, so the member
tightens under Compact like everything else. Adding a `@utility` here would claim
geometry the member does not own.

### 2. Wire the namespace

- `web/internal/namespace.ts` — `Subhead: ControlPanelSubhead`, placed
  immediately after `Section` (the literal's order is what an author reads).
  Extend that file's doc comment.
- `web/index.ts` — export `ControlPanelSubheadProps`, and add `Subhead` to the
  plugin `description`'s closed-set list. That string is what `docs/plugins-*.md`
  and the AUTOGEN block in `control-panel/CLAUDE.md` are generated from, so
  `plugins-doc-in-sync` fails until `./equin build` runs.

### 3. Rewire data-view — `data-view/web/internal/field-sections.tsx`

Delete `FieldSectionHeading`; render `<ControlPanel.Subhead>{section.label}</ControlPanel.Subhead>`.
Its rationale moves into the member's doc comment — it is the primitive's
argument now, not data-view's. `data-view → control-panel` is an existing edge.

**No call-site changes.** `properties-control.tsx`, `group-by-control.tsx` and
`field-search-list.tsx` are untouched — `FieldSections` is the only edit, which
is the point of having landed it.

### 4. Fixture — `control-panel/fixtures/internal/control-panel-fixtures.tsx`

Add `control-panel/subhead-rail` as §1.4, between `block-label-rail` and
`group-nested-rail`. Its own fixture, not a slot bolted onto `block-label-rail`:
the id is what a failure names.

Render a `Section` (labelled through a `data-geo="eyebrow"` span) containing a
`RailMarker id="rail-icon"`, a `Subhead` wrapping `<Fills id="subhead">`, and an
icon-bearing `Row` with `RowRail id="rail-text"` + `<Fills id="row-label">`.
The panel must HAVE an icon column, exactly as `block-label-rail` does — without
one the two rails are the same x and any drift is invisible.

Invariants: `leftPack` `subhead`, `eyebrow` and `row-icon-cell` all after
`rail-icon` at gap 0 (the sub-head is on the eyebrow's rail, and the row grid is
the independent mechanism it is compared against); `leftPack` `row-label` after
`rail-text` (the rung it is NOT, so a panel whose two rails collapsed fails here
rather than passing silently); `noClip`. **No `noOverlap`** — the oracle walks
slots pairwise in DOM order asserting `cur.right <= next.left`, a claim about
adjacent cells of ONE row; these live on three rows and `rail-icon` is a
zero-width probe inside the box of everything starting at its x. Same reasoning
`setting-rail` and `block-label-rail` already record.

### 5. Unit test — `control-panel/web/__tests__/control-panel.test.tsx`

- Extend the existing "marks a Section and a Footer as bands, and nothing else"
  case: drop a `Subhead` into one section beside the `RuleList` and `Empty`, and
  leave the `.cp-band` count at 3. That is the identical assertion pinning
  `RuleList`/`Empty`, and it is exactly the failure mode.
- Add a companion asserting the member declares no inline padding and no rail
  class — a class-token read (jsdom has no Tailwind), the same read
  `useRailGuard` makes. The geometry is `subhead-rail`'s job.

### 6. Docs

`control-panel/CLAUDE.md` (hand-written prose only, above the AUTOGEN fence):
the namespace list at the top; the "read the members as a set" sentence; the
"`RuleList` and `Empty` are deliberately not bands" line gains `Subhead` with its
own clause; a new short section after "The four field members" (do **not** widen
that title — a sub-head is not a field member) naming the three label rungs and
which one this is, citing `subhead-rail` rather than the paragraph; and
`subhead-rail` added to the Enforcement list beside `block-label-rail`.

`data-view/CLAUDE.md`, "Field sections: a band per contributor": the heading is
`ControlPanel.Subhead`, so it follows the panel's rails and typography instead of
being hand-rolled here; the member carries no rail class, so the one surface with
no panel (`field-picker.tsx`) lands it on that region's content edge by the same
rule. Delete the wording that describes the heading's own typography.

## Verification

```bash
./equin test plugins/primitives/plugins/css/plugins/control-panel
./equin test plugins/primitives/plugins/data-view
./equin build                  # regenerates AUTOGEN blocks + docs/*
./equin check layout-geometry  # sweeps subhead-rail at 262/320/500/524
```

**Falsify the fixture before trusting it** — the house standard (`long-label` and
`group-nested-rail` both carry one). Locally put `px-2xs` back on `subhead.tsx`
and confirm `control-panel/subhead-rail` fails on the `subhead` `leftPack` at
every width. If it still passes, the probe is measuring the wrong box.

In the deployed app, one surface of each host kind:

1. **`/debug/build` → view settings → Properties.** The `Common` / `Build` / …
   headings sit on the same left edge as the "PROPERTIES" eyebrow — 4px left of
   where they render today — and left of the rows' checkboxes.
2. **The same panel's Group by band** — headings on the eyebrow's edge, radio
   marks an icon column in.
3. **A filter rule's field cell** (the bare `InlinePopover`): headings render at
   the popover's own content edge with no panel present, and no rail-guard error
   appears in the dev console on the five in-panel `FieldSearchList` mounts.

In all three: no hairline between a heading and the rows under it. That is the
`cp-band` claim, and it is visible.

## Flagged, deliberately not done

- **Semantic grouping.** A container could carry `role="group" aria-labelledby`
  so a screen reader announces "Build, 8 items". No panel surface groups
  semantically today — `ControlPanel.Section` itself renders a bare `<div>` with
  no role — so that decision should be taken for `Section` first, not smuggled in
  through its sub-rung.
- **`Subhead` and `Section`'s `description` render identically** (both
  caption/muted). Adding weight to separate a heading from prose is a visual
  redesign; this change is a vocabulary move. Call it if review disagrees.
- **quick-theme's variant labels are not this member.**
  `quick-theme-panel.tsx` draws `<Text variant="label">` above each variant
  picker inside one `Section` — but that labels exactly ONE control wider than a
  row, which is `ControlPanel.Block`'s definition verbatim (and it already uses
  the field-label rung's typography). Migrating it is its own task with a visible
  consequence: that panel has an icon column, so a real `Block` label moves 26px
  right.
- **The `css/row` double-inset** inside the five in-panel `FieldSearchList`
  mounts is pre-existing and unchanged, but this work makes it marginally more
  visible (the heading moves 4px left; the rows do not). Closing it means
  migrating that leaf to the panel vocabulary — the same follow-up as the bare
  popover.
