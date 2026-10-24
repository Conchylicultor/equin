# Drain hover-reveal-safety Burndown Allowlist (34 sites)

_Date: 2026-06-19_

## Context

The `hover-reveal-safety/no-uncoupled-hover-reveal` lint rule bans bare
`opacity-0 group-hover:opacity-100` patterns where the hidden element remains
fully interactive (a live invisible click-target). Three sites were already
migrated as reference examples. The remaining 34 are temporarily parked in the
`ignores` array at:

```
plugins/framework/plugins/tooling/plugins/lint/plugins/hover-reveal-safety/lint/index.ts
```

After all 34 are migrated, remove them from that array and the rule enforces
clean for the whole codebase.

## Migration Primitives

### From `@plugins/primitives/plugins/hover-reveal/web`

```ts
hoverRevealGroup = "group/hover-reveal"
hoverRevealTarget =
  "opacity-0 pointer-events-none transition-opacity " +
  "group-hover/hover-reveal:opacity-100 group-hover/hover-reveal:pointer-events-auto " +
  "group-focus-within/hover-reveal:opacity-100 group-focus-within/hover-reveal:pointer-events-auto"
```

### From `@plugins/primitives/plugins/row-actions/web`

`RowActions`, `RowActionButton`, `rowActionsAnchor` — for trailing icon button clusters on list rows.

## Four Migration Approaches

**A — `hoverRevealGroup` + `hoverRevealTarget`**
Use when: the file owns the parent group element, and the target reveals to full `opacity-100`.
Replace bare `group` (or named group used solely for this reveal) with `hoverRevealGroup`;
replace `opacity-0 [group-hover:opacity-100]` with `hoverRevealTarget`, keeping positional/visual classes.

**B — Manual pointer-events coupling**
Use when: the group name is external, target reveals to partial opacity, or `hoverRevealTarget`'s
full opacity is wrong. Add `pointer-events-none` at rest, add `group-hover/<name>:pointer-events-auto`
(and focus-within/focus-visible variants where applicable).

**C — Permanent `pointer-events-none`**
Use when: purely non-interactive display element (count badge, text label). Just add
`pointer-events-none` permanently.

**D — Special / complex**
Use when: conditional opacity states, dual-hide mechanisms, or multiple sub-elements need bespoke handling.

---

## File-by-File Migration

### APPROACH A

---

**File 3 — `plugins/apps/plugins/pages/plugins/page-tree/web/components/page-header.tsx`**

1. `<Stack gap="xs" className="group/header pt-lg">` — add `hoverRevealGroup` to className
   (`group/header` is used solely for this reveal so can be replaced or extended).
2. `<Stack direction="row" gap="2xs" className="opacity-0 transition-opacity group-hover/header:opacity-100">` —
   replace the three opacity classes with `hoverRevealTarget`.

---

**File 5 — `plugins/apps/plugins/pages/plugins/page-tree/web/components/page-cover.tsx`**

1. `<div className="group/cover relative h-[30vh]">` — add `hoverRevealGroup` to className.
2. `className="absolute right-3 bottom-3 z-raised flex gap-xs opacity-0 transition-opacity group-hover/cover:opacity-100"` —
   replace the opacity reveal classes with `hoverRevealTarget`; keep `absolute right-3 bottom-3 z-raised flex gap-xs`.

---

**File 7 — `plugins/page/plugins/bookmark/web/components/bookmark-block.tsx`**

1. Parent `<div className="group relative">` → `<div className={cn("relative", hoverRevealGroup)}>`.
2. Button: replace `opacity-0 transition-opacity group-hover:opacity-100` with `hoverRevealTarget`.

---

**File 8 — `plugins/page/plugins/video/web/components/video-block.tsx`**

Same pattern as File 7. Add `hoverRevealGroup` to parent `group` div; replace button's opacity reveal classes with `hoverRevealTarget`.

---

**File 9 — `plugins/page/plugins/file/web/components/file-block.tsx`**

Same pattern as File 7. Add `hoverRevealGroup` to parent `group` div; replace button's opacity reveal with `hoverRevealTarget`.

---

**File 10 — `plugins/page/plugins/audio/web/components/audio-block.tsx`**

Same pattern as File 7. Add `hoverRevealGroup` to parent `group` div; replace button's opacity reveal with `hoverRevealTarget`.

---

**File 11 — `plugins/page/plugins/image/web/components/image-block.tsx`**

Two sub-targets:
1. Parent: add `hoverRevealGroup` to the bare `group` wrapper div.
2. Remove button (~line 100): replace `opacity-0 transition-opacity group-hover:opacity-100` with `hoverRevealTarget`.
3. Resize indicator inner `<div>` (~line 112): add `pointer-events-none` permanently — purely visual indicator, never interactive.

---

**File 12 — `plugins/page/plugins/embed/web/components/embed-block.tsx`**

1. Parent div: add `hoverRevealGroup`.
2. "Replace URL" button: replace `opacity-0 transition-opacity group-hover:opacity-100` with `hoverRevealTarget`;
   keep `hover:text-foreground hover:underline` and all non-opacity classes.

---

**File 13 — `plugins/page/plugins/code-block/web/components/code-block.tsx`**

1. Parent `<div className="group relative ...">` — add `hoverRevealGroup`.
2. Toolbar div: replace `opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100` with
   `hoverRevealTarget` (already includes `group-focus-within/hover-reveal` coupling).

---

**File 16 — `plugins/tasks/plugins/task-draft-form/web/components/chain-connector.tsx`**

1. Parent `<div className="group/connector ...">` — replace `group/connector` with `hoverRevealGroup`
   (used solely for these two reveals).
2. Link button: replace `opacity-0 transition-opacity group-hover/connector:opacity-100 focus-visible:opacity-100`
   with `hoverRevealTarget`.
3. Unlink/insert div: replace `absolute inset-0 ... opacity-0 transition-opacity group-hover/connector:opacity-100`
   — keep positional classes, replace opacity reveal with `hoverRevealTarget`.

---

**File 17 — `plugins/tasks/plugins/task-description/web/components/description-view.tsx`**

1. Parent div `className="group relative min-h-48 ..."` — add `hoverRevealGroup`.
2. Edit button: replace `opacity-0 transition-opacity group-hover:opacity-100` with `hoverRevealTarget`.

---

**File 18 — `plugins/layouts/plugins/miller/web/components/resize-handle.tsx`**

1. Parent `<div className="group relative ...">` — add `hoverRevealGroup`.
2. Collapse button: replace `opacity-0 group-hover:opacity-100` with `hoverRevealTarget`.

---

**File 21 — `plugins/primitives/plugins/text-editor/plugins/paste-images/web/components/attachment-thumbnail.tsx`**

1. Parent `<span className="group relative inline-block">` — add `hoverRevealGroup`.
2. Remove button: replace `opacity-0 transition-opacity group-hover:opacity-100` with `hoverRevealTarget`.

---

**File 22 — `plugins/active-data/web/internal/active-data-inline-node.tsx`**

1. Parent `<span className="group relative inline-flex align-middle">` — add `hoverRevealGroup`.
2. Remove button: replace `opacity-0 transition-opacity group-hover:opacity-100` with `hoverRevealTarget`.

---

**File 33 — `plugins/apps/plugins/sonata/plugins/library/web/components/song-card.tsx`**

1. Parent `<Card className="group relative ...">` — add `hoverRevealGroup`.
2. Delete button: replace `opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100`
   with `hoverRevealTarget` (includes focus coupling; remove now-covered `focus-visible:opacity-100`).

---

### APPROACH B

---

**File 2 — `plugins/apps/plugins/surface/plugins/solo/web/solo-placement.tsx`**

Inner wrapper div (parent group `group/solo`). Add to className:
```
pointer-events-none group-hover/solo:pointer-events-auto focus-within:pointer-events-auto
```

---

**File 4 — `plugins/apps/plugins/pages/plugins/page-tree/web/components/pages-sidebar.tsx`**

`IconButton` (~line 156), parent group is `group/label` (external from SidebarPaneSection). Add to className:
```
pointer-events-none group-hover/label:pointer-events-auto focus-visible:pointer-events-auto
```

---

**File 6 — `plugins/page/plugins/editor/web/components/block-row.tsx`**

Three gutter buttons reveal to `opacity-60` (not 100), so `hoverRevealTarget` is wrong. Parent group is `group/row`.

For the **+ insert** and **drag handle** buttons (always `opacity-0` at rest):
```
pointer-events-none group-hover/row:pointer-events-auto
```

For the **collapse chevron** button (conditional: `opacity-60` when collapsed, `opacity-0` otherwise):
```tsx
// Instead of:
collapsed ? "opacity-60" : "opacity-0 group-hover/row:opacity-60"

// Use:
collapsed
  ? "opacity-60"
  : "opacity-0 pointer-events-none group-hover/row:opacity-60 group-hover/row:pointer-events-auto"
```

---

**File 14 — `plugins/reorder/plugins/editor/web/internal/items.tsx`**

Two buttons, both reveal to `opacity-80`:

1. Item × button (named group `group/reorder-item`):
   Add `pointer-events-none group-hover/reorder-item:pointer-events-auto hover:pointer-events-auto`
2. Spacer × button (bare `group`):
   Add `pointer-events-none group-hover:pointer-events-auto hover:pointer-events-auto`

---

**File 15 — `plugins/tasks/plugins/attempt-view/web/components/attempt-pane.tsx`**

SideBySide button wrapper div (parent is bare `group` on `<li>`). Add:
```
pointer-events-none group-hover:pointer-events-auto
```

---

**File 19 — `plugins/primitives/plugins/multi-select/web/internal/selection-checkbox.tsx`**

Checkbox element; group comes from external parent row. Add alongside existing conditional:
```tsx
!isActive && "pointer-events-none group-hover:pointer-events-auto"
```

---

**File 24 — `plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/group-box.tsx`**

Parent group is `group/header` (from GroupContainer). Two targets:
1. Drag handle button: add `pointer-events-none group-hover/header:pointer-events-auto`
2. RowActionButton's `className` prop: add `pointer-events-none group-hover/header:pointer-events-auto`

---

**File 27 — `plugins/review/plugins/plugin-changes/plugins/file-changes/web/components/file-changes-section.tsx`**

CopyButton; parent group is `group/path`. Add to className:
```
pointer-events-none group-hover/path:pointer-events-auto
```

---

**File 28 — `plugins/review/plugins/code-review/web/components/review-file-row.tsx`**

CopyButton; parent group is `group/path`. Add to className:
```
pointer-events-none group-hover/path:pointer-events-auto
```

---

**File 29 — `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/web/internal/event-action-context.tsx`**

Actions `<Stack>`; parent group is `group/row`. Add to className:
```
pointer-events-none group-hover/row:pointer-events-auto focus-within:pointer-events-auto
```

---

**File 30 — `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/unknown/web/components/unknown-row.tsx`**

`InvestigateEventButton` className; parent group is `group/row`. Add:
```
pointer-events-none group-hover/row:pointer-events-auto focus-within:pointer-events-auto
```

---

**File 31 — `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/attachment/web/components/generic-attachment-view.tsx`**

`InvestigateEventButton` className; parent group is `group/row`. Add:
```
pointer-events-none group-hover/row:pointer-events-auto focus-within:pointer-events-auto
```

---

**File 32 — `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/file-path/web/components/file-path.tsx`**

CopyButton; parent group is `group/path` (self-owned via `<Inline className="group/path">`). Add:
```
pointer-events-none group-hover/path:pointer-events-auto
```

---

**File 34 — `plugins/primitives/plugins/launch/web/components/launch-control.tsx`**

Play `Button` inside a `DropdownMenuItem`; group is `group/dropdown-menu-item` (shadcn internal). Add:
```
pointer-events-none group-hover/dropdown-menu-item:pointer-events-auto
```

---

### APPROACH C

---

**File 23 — `plugins/conversations/plugins/conversations-view/web/components/conv-count-label.tsx`**

Count `<Text>` — display-only. Add `pointer-events-none` permanently.

---

**File 25 — `plugins/conversations/plugins/conversations-view/plugins/grouped/web/components/group-container.tsx`**

Count `<Badge>` — display-only. Add `pointer-events-none` permanently.

---

**File 26 — `plugins/conversations/plugins/conversations-view/plugins/queue/web/components/queue-view.tsx`**

Section count `<Badge>` — display-only. Add `pointer-events-none` permanently.

---

### APPROACH D

---

**File 1 — `plugins/apps/web/components/app-tab-bar.tsx`**

Close (×) button on tab chips; the `active` prop makes the button `opacity-70` (always visible)
but the rest state has `opacity-0` without pointer-events gating.

```tsx
// Before:
cn("... opacity-0 ... group-hover:opacity-100 focus-visible:opacity-100", active && "opacity-70")

// After:
cn(
  "... group-hover:opacity-100 group-hover:pointer-events-auto",
  "focus-visible:opacity-100 focus-visible:pointer-events-auto",
  active ? "opacity-70" : "opacity-0 pointer-events-none",
)
```

This ensures the inactive-at-rest state is properly hidden (`pointer-events-none`)
while the active state remains always interactive.

---

**File 20 — `plugins/primitives/plugins/tree/web/internal/tree-row-chrome.tsx`**

Four sub-patterns, all under `group/tree-row`:

**Sub-fix 1 — Icon span fading OUT on hover (when expandable)**

The icon fades to `opacity-0` on hover to reveal the overlaid chevron. Add pointer-events removal
so the faded icon doesn't capture clicks away from the chevron:
```tsx
expandable && "group-hover/tree-row:opacity-0 group-hover/tree-row:pointer-events-none"
```

**Sub-fix 2 — Overlaid chevron button (fades IN on hover)**

Currently: `opacity-0 group-hover/tree-row:opacity-100 focus-visible:opacity-100`

Add coupling:
```
opacity-0 pointer-events-none
group-hover/tree-row:opacity-100 group-hover/tree-row:pointer-events-auto
focus-visible:opacity-100 focus-visible:pointer-events-auto
```

**Sub-fix 3 — Leaf-node chevron (partial opacity)**

Branch revealing to `opacity-60` (not 100): add `pointer-events-none group-hover/tree-row:pointer-events-auto`.
The `hasChildren` branch at `opacity-40` rest is always interactive — no fix needed.

**Sub-fix 4 — Actions cluster (`w-0 opacity-0` at rest)**

The `w-0 overflow-hidden` partially prevents interaction but not fully. Add:
```
pointer-events-none group-hover/tree-row:pointer-events-auto group-focus-within/tree-row:pointer-events-auto
```
alongside the existing `group-hover/tree-row:w-auto group-focus-within/tree-row:w-auto`.

---

## Allowlist Cleanup

After all 34 files are migrated, remove every path from the `ignores["no-uncoupled-hover-reveal"]`
array in:
```
plugins/framework/plugins/tooling/plugins/lint/plugins/hover-reveal-safety/lint/index.ts
```

## Sequencing

1. **Approach C first** (Files 23, 25, 26) — trivial one-liners, zero risk.
2. **Approach A** (Files 3, 5, 7–13, 16–18, 21–22, 33) — import + classname swap.
   Ensure `hoverRevealGroup` is imported from `@plugins/primitives/plugins/hover-reveal/web`.
3. **Approach B** (Files 2, 4, 6, 14–15, 19, 24, 27–32, 34) — manual coupling additions.
4. **Approach D last** (Files 1, 20) — most complex, read surrounding code before editing.
5. **Allowlist removal** — only after all 34 edits pass lint.

## Verification

```bash
./equin check type-check
```

Confirm zero `hover-reveal-safety/no-uncoupled-hover-reveal` violations.

Spot-check in the browser:
- Hover reveals animate (opacity transition fires on hover).
- Revealed buttons are clickable after hover.
- Non-hovered, hidden elements cannot be accidentally clicked.
- Focus-within/focus-visible reveals still work for keyboard navigation.
- File 1: active tab close button stays at `opacity-70` without hover.
- File 20: tree row icon/chevron swap still animates correctly.
