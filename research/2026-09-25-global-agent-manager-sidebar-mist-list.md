# Agent manager sidebar list → Mist mockup (proto-1789643584-ldt6)

## Context

The agent manager now wears the Mist theme (commit 35639261d), but its sidebar
conversation list still has the old layout. The mockup's saved picks
(`mist-lead=status`, `mist-tabs=button`, `mist-groups=quiet`,
`mist-density=single`) describe a different list:

| | Today | Mockup |
|---|---|---|
| Row | two lines: avatar + status overlay, title / chips row + "11m ago" | one line: status dot · title · pie · count chip · "11m" |
| Selected row | `Row` `bg-accent`, which Mist already maps to a neutral grey | neutral fill (already true, verify only) |
| Group header | chevron on the left · label · count on the far right | label · count right after it ("Queue 6") · chevron only on hover |
| View switcher | compact-fold strip of ghost chips ("Queue  Models  ⋮") | one full-width button row (icon · "Queue" · chevron shown on hover) that opens the views menu |

**Scope (decided):** the new look is set by **props on the conversation sidebar
only**. The DataView pieces gain opt-in options whose defaults render exactly
what they render today, so no other app (and no other DataView in the agent
manager) changes. `ConversationsSidebarDataView` is rendered only by the agent
manager (`conversations-view` → `Shell.Sidebar`).

**Out of scope (decided):** short titles ("App UI cleanup"). Rows keep the
full title, truncated by the row. The mockup's activity icons (hourglass,
upload, flask) have no data source today and are also left out.

## Design

### 1. Single-line conversation row: `ConversationItem layout="line"`

`plugins/conversations/plugins/conversation-ui/plugins/item/web/components/conversation-item.tsx`

Add a third layout next to `block` / `inline`. Nothing that uses `block` or
`inline` today changes.

```
[ConvStatusDot] [ConvTitle — Fill, truncates] [ChipsSlot] [ConvRelativeTime short]
```

- **Lead:** the existing `ConvStatusDot` (`CONV_STATUS_DOT`), no `AvatarSlot`.
  The dot sits in a fixed lead box so every title starts on the same column.
- **Chips:** the existing `Item.Chips` slot, unchanged. It already yields the
  progress chip (`conversation-progress` → `SegmentedProgressBar compact`,
  which renders the **pie** because of the agent manager's per-app variant
  config) and the dependent-count chip.
- **Time:** `ConvRelativeTime` takes a `format` prop and passes it through (see §2).
- The `working` opacity rule and the `sys` badge behave as in `block`.

### 2. Short relative time: `RelativeTime format="short"`

`plugins/primitives/plugins/relative-time/web/internal/relative-time.tsx`

`formatRelativeTime(date, format: "ago" | "short" = "ago")` gives `"11m"`,
`"3h"`, `"2d"`, and `"now"` for anything under a minute. `RelativeTime` gets the
same optional `format` prop. The default stays `"ago"`, so existing callers are
unchanged.

### 3. Sidebar sources use the line row

`.../conversations-view/plugins/data-view/plugins/{queue,history}/web/components/sidebar-{queue,history}.tsx`

`viewOptions.list`:
`{ renderRow: (c) => <ConversationItem conv={c} layout="line" />, size: "sm" }`.
The `×N` aggregate badge (list view trailing cell) and the hover item actions
stay as they are.

### 4. Quiet group headers: a DataView surface option

The group header is shared chrome (`GroupedSections` →
`SectionHeaderRow`), so the new style is an opt-in, surface-level choice:

- **Type (core):** `DataViewProps.groupHeaders?: "standard" | "quiet"`,
  default `"standard"`. `MergedDataView` forwards it the same way it forwards
  `density` / `toolbar`, and the host passes it to the view children with the
  other surface props (`density` is the model: `types.ts` ~l.659 / l.1016).
- **`SectionHeaderRow`** (`primitives/css/row`) gains
  `disclosure?: "lead" | "trailing"` (default `"lead"` = today).
  `"trailing"` moves the `CollapsibleChevron` after the label and shows it only
  on hover/focus-visible, using the row's own hover-reveal, not a hand-written
  opacity rule. `aria-expanded` and the click target are unchanged.
- **`GroupedSections`** takes `headerStyle`. For `"quiet"`, the count sits
  inline right after the label (in the `children` run, still
  `Text caption muted`), and the chevron is `disclosure="trailing"`. Any
  `headerActions` stay in the trailing cluster. `"standard"` renders exactly the
  node it renders today.
- The list, gallery, tree and icons views pass `props.groupHeaders` to
  `GroupedSections`. The table view composes its own header, so it ignores the
  option; that is documented in `ListViewOptions` / the data-view CLAUDE.md.
- Labels are already sentence case: group headers use `variant="value"`, and the
  section enum labels are "Queue" / "Working".

### 5. Button-style view switcher: a hosted toolbar frame with a row-form switcher

The sidebar is narrow, so today it gets the compact fold, and a
`ToolbarArrangement` would be ignored there. The existing way for a surface to
draw its own chrome is `HostedToolbar` (`kind: "hosted"`). Its frame receives
`switcher` (the collapsed switcher), `options`, `creators` and `body`
(precedent: `running-agents-band.tsx`).

- **Row form of the collapsed switcher.** `HostedToolbar` gains
  `forms?: { switcher: "chip" | "row" }` (default `"chip"`). Like
  `ToolbarPartForms`, this is data: the host still builds the part.
  `CollapsedViewSwitcher` (`view-core/web/components/collapsed-view-switcher.tsx`)
  takes `appearance: "chip" | "row"`:
  - `chip`: today's `Button variant="secondary" shape="pill"`.
  - `row`: a full-width ghost row with the view icon in the same lead column as
    the rows' status dot, the view name, then the chevron shown on hover (and
    while the menu is open). Same menu: the other views, Add view, View settings….
- **Sidebar frame** (new, in `conversations-view/plugins/data-view/web/components/`):
  `SIDEBAR_TOOLBAR: HostedToolbar = { kind: "hosted", forms: { switcher: "row" }, frame: SidebarFrame }`.
  The frame renders a sticky header line (`[switcher — Fill] [options]`), then
  `body`. `options` (search and every control behind one trigger) stays
  hover-revealed at the right of the line, per the `HostedToolbarParts` contract.
  `creators` is null here.
- **`ConversationsSidebarDataView`** passes
  `toolbar={SIDEBAR_TOOLBAR}` and `groupHeaders="quiet"` to `MergedDataView`.

The mockup also puts search inside the view menu. That is not done here, because
the host hands search out inside `options`. The option trigger sits on the same
line instead.

### 6. Selected row

No code change expected: `Row` `selected` → `bg-accent`, and Mist sets `accent`
to its neutral fill. Confirm this in the screenshot. If an accent bar shows up,
find where it comes from before changing anything.

## Files

- `plugins/conversations/plugins/conversation-ui/plugins/item/web/components/conversation-item.tsx`: `layout="line"`, `ConvRelativeTime format`
- `plugins/primitives/plugins/relative-time/web/internal/relative-time.tsx`: `format`
- `plugins/primitives/plugins/css/plugins/row/web/internal/section-header-row.tsx`: `disclosure`
- `plugins/primitives/plugins/data-view/web/internal/grouped-sections.tsx`: `headerStyle`
- `plugins/primitives/plugins/data-view/core/internal/types.ts`: `groupHeaders` on the surface props and the view-child props
- `plugins/primitives/plugins/data-view/core/internal/toolbar-arrangement.ts`: `HostedToolbar.forms`
- `plugins/primitives/plugins/data-view/web/components/merged-data-view.tsx` + the host/shell that builds the switcher: forward the options
- `plugins/primitives/plugins/data-view/plugins/view-core/web/components/collapsed-view-switcher.tsx`: `appearance`
- list / gallery / tree / icons view components: pass `groupHeaders` through
- `plugins/conversations/plugins/conversations-view/plugins/data-view/…`: the sidebar frame, the `toolbar` / `groupHeaders` props, and `layout="line"` in both sources
- CLAUDE.md prose for data-view (toolbar + grouping sections), the row primitive and conversation-item

## Verification

- `./equin test` on `primitives/relative-time`, `primitives/css/row`,
  `primitives/data-view` (including `toolbar-arrangement.test.tsx`) and
  `conversations/conversation-ui/item`. Add cases for:
  - `formatRelativeTime` in the short format
  - `SectionHeaderRow disclosure="trailing"` (chevron after the label, `aria-expanded` kept)
  - `GroupedSections` rendering today's node for `"standard"`
  - `CollapsedViewSwitcher appearance="row"` keeping the same menu
- `./equin build` (background), then run `compare-diff.ts --name
  proto-1789643584-ldt6` and screenshot the agent-manager sidebar next to
  `/tmp/…/mock-before.png`.
- No-regression screenshots: Home (capsule chip switcher), Tasks list (grouped
  headers), and another app's grouped DataView must look exactly as before.
