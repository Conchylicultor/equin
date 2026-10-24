# Row primitive + ad-hoc interactive-row lint guardrail

**Date:** 2026-06-04
**Category:** global (primitives + tooling/lint + repo-wide migration)
**Status:** Plan — awaiting approval
**Follow-up to:** [`2026-06-04-global-adhoc-chip-lint-guardrail.md`](./2026-06-04-global-adhoc-chip-lint-guardrail.md) (chip rule — already landed, commit `32b8bf82f`)

## Context

The `badge/no-adhoc-chip` lint rule made static-chip markup self-sustaining, but it
**deliberately excludes interactive markup** (anything with `w-full`, `hover:bg-`, or
`text-left`) because there was no sanctioned primitive for a generic clickable row. As a
result ~50 files hand-roll a "rounded + padded interactive" row/menu/section-header shape
ad-hoc, plus ~8 ghost action buttons and ~3 tab strips reinvent `Button`/`SegmentedControl`.
The codebase cannot reach a fully self-sustaining "no ad-hoc rounded+padded interactive
markup" guarantee until those shapes have a home and the guardrail is widened to enforce it.

This plan: (1) adds a generic **`Row`** primitive (+ a `SectionHeaderRow` companion), (2)
refactors the tree plugin's `TreeRowChrome` to compose `Row`, (3) migrates every ad-hoc site
to the correct primitive (`Row`/`SectionHeaderRow`, or the existing `Button`/`IconButton`/
`SegmentedControl`), and (4) adds a **`row/no-adhoc-row`** lint rule that is the exact
*complement* of the chip rule — together they partition all rounded+padded intrinsic markup
with **zero allowlist** (`ignores: []`).

### Decisions locked with the user

- **Coverage = Complete.** Migrate rows → `Row`/`SectionHeaderRow`, ~8 ghost action buttons
  → `Button`/`IconButton`, ~3 tab strips → `SegmentedControl`. The guardrail catches the row
  shape *and* the ghost-button/tab shape so no rounded+padded interactive markup escapes.
- **Delivery = One atomic change.** Primitive + companion + tree refactor + all migrations +
  the new rule land together (the rule with empty `ignores` is red until migration completes —
  same constraint the chip guardrail honored).

### The load-bearing idea: two rules partition the space

The chip rule already fires on `rounded + small px/py` on intrinsic `span/div/button` **and
excludes interactive signals** (`w-full`/`hover:bg-`/`text-left`/positioned/named-pad). The
new row rule claims **exactly that excluded set**: same shape **with** an interactive signal.
The predicates are complementary (chip: *NOT* signal; row: *signal*), so **no element ever
trips both** — no double-flag, no conflicting message. Every rounded+padded intrinsic element
is owned by exactly one rule: static → chips, interactive → `Row`/`Button`/`SegmentedControl`.

### Why this is feasible with empty `ignores` (verified)

The rule visits only `JSXAttribute[name=className]` on **intrinsic** `span/div/button/a`. That
makes all the worrying buckets safe by construction:
- **`components/ui/*` shadcn internals** render on capitalized primitives
  (`<InputPrimitive>`, `<MenuPrimitive.Item>`, `<ButtonPrimitive>`) — member/identifier hosts
  the gate skips. Their style strings live in `cva(...)` calls, never in a JSX `className`, so
  they're never visited. Menu items use `focus:bg-`/`data-[highlighted]:`, not `hover:bg-`.
  *(Confirmed in `input.tsx`, `dropdown-menu.tsx`, `sidebar.tsx`, `button.tsx`.)*
- **Every `<Row>`/`<SectionHeaderRow>`/`<Button>`/`<SegmentedControl>` call site** is a
  capitalized component → skipped regardless of what `className` it passes. Call sites may
  pass raw `px-4 py-3` overrides freely; only intrinsic elements are linted.
- **The primitives' own definitions** escape via the **named-padding token**: `Row` uses the
  already-existing `p-row` utility (`app.css:282`), exactly as `Badge` uses `p-chip` and
  `data-table` uses `p-control`. `/^p-[a-z]/` is an exclusion, so `row.tsx`'s intrinsic
  `<button>` is not flagged. No inline-disable needed for `Row` itself.

---

## Part A — The `Row` primitive

New plugin **`plugins/primitives/plugins/row/`** (sibling of `badge`, `toggle-chip`).

### File: `plugins/primitives/plugins/row/web/internal/row.tsx`

Mirror `toggle-chip/web/internal/toggle-chip.tsx` byte-for-byte in structure (a `VARIANT`-style
class map, props interface ending in `[key: string]: unknown`, single `cn()` component with
polymorphic `As`). Divergence from ToggleChip: **`Row` must explicitly accept and forward
`ref`** (ToggleChip/Badge spread `...rest`, which React strips `ref` from) — the tree's DnD
needs the row element ref (§C).

```tsx
export type RowSize = "sm" | "md";
export type RowHover = "accent" | "muted";

export interface RowProps {
  selected?: boolean;          // persistent selection → bg-accent; aria-current on buttons
  size?: RowSize;              // text+gap density only; PADDING is always p-row. sm=text-xs gap-1.5, md=text-sm gap-2. Default md.
  hover?: RowHover;            // "accent" (sidebars/menus, default) | "muted" (cards/popovers)
  bordered?: boolean;          // adds `border` (cluster G chip-rows)
  indent?: number;             // tree depth px → style paddingLeft (overrides p-row's left)
  icon?: React.ReactNode;      // leading slot (icon / StatusDot / chevron)
  actions?: React.ReactNode;   // trailing slot; ml-auto, hover-revealed by default
  actionsAlwaysVisible?: boolean;
  as?: React.ElementType;      // default "button"; "a" link rows, "div"/"li" containers
  ref?: React.Ref<HTMLElement>;
  disabled?: boolean;
  className?: string;
  title?: string;
  children: React.ReactNode;
  [key: string]: unknown;      // passthrough: onClick, href, download, role, …
}
```

Base class on the intrinsic `<As>`:
```
"group flex w-full items-center rounded p-row text-left transition-colors
 disabled:pointer-events-none disabled:opacity-50"
```
`cn()` fragments:
- `size === "sm" && "gap-1.5 text-xs"`, `size === "md" && "gap-2 text-sm"`
- `hover === "accent" && (selected ? "bg-accent" : "hover:bg-accent")`
- `hover === "muted"  && (selected ? "bg-muted"  : "hover:bg-muted/50")`
- `bordered && "border"`
- button-only (mirror ToggleChip's `isButton` gating): `type="button"`, `disabled`,
  `aria-current={selected || undefined}`
- `style={indent !== undefined ? { paddingLeft: indent } : undefined}`

Trailing slot (stops click propagation so action clicks don't fire row `onClick`):
```tsx
{actions && (
  <span onClick={(e) => e.stopPropagation()}
    className={cn("ml-auto flex shrink-0 items-center gap-0.5",
      !actionsAlwaysVisible && "opacity-0 group-hover:opacity-100")}>
    {actions}
  </span>
)}
```

**Why `p-row`, not a `size`-driven `px/py`:** the density-token group already ships
`p-row` (`--pad-row-x 0.5rem / -y 0.375rem` = 8×6px), the canonical row density. Using it (a)
collapses the catalog's px-1..4 / py-0.5..3 chaos to one density — the consolidation win, like
the chip plan's size normalization — and (b) lets `row.tsx` escape its own lint rule via the
named-pad exclusion with zero inline-disable. `size` controls only text/gap. The rare roomier
row passes a `className` override (safe — it's on the `<Row>` component, never linted).

### Concrete call-site mappings (covers clusters A/B/C/F/G)

```tsx
// B selectable nav — tasks-recent-view.tsx:53
<Row selected={isSel} icon={<StatusIcon …/>} actions={<RelativeTime date={t.updatedAt}/>}
     actionsAlwaysVisible onClick={() => select(t.id)}>{t.title}</Row>

// C popover menu item — page-link-block.tsx:60
<Row size="sm" hover="muted" icon={<PageIcon …/>} onClick={() => onPick(doc)}>{doc.title}</Row>

// F link/download row — task-attachments.tsx:52
<Row as="a" href={url} download bordered hover="muted" icon={<FileIcon/>}>{name}</Row>

// G bordered chip-row with remove — task-dependencies.tsx:114
<Row as="div" bordered size="sm" hover="muted" actionsAlwaysVisible
     actions={<button onClick={onRemove}><MdClose/></button>}>
  <button onClick={openDep} className={cn(isTerminal && "line-through text-muted-foreground")}>{title}</button>
</Row>
```

### File: `plugins/primitives/plugins/row/web/index.ts`
Barrel-pure (mirror toggle-chip's): re-export `Row`, `SectionHeaderRow` + prop types, single
default `PluginDefinition`. No logic.

### File: `plugins/primitives/plugins/row/package.json`
Mirror `badge/package.json` (`@singularity/plugin-primitives-row`, private).

---

## Part B — `SectionHeaderRow` companion (clusters D + E, ~13 sites)

A named companion in the same plugin/barrel (precedent: `SegmentedControl` lives with
`ToggleChip`). It composes `<Row>` + `CollapsibleChevron` + a typographic variant. **Not** a
chevron prop on `Row` — section headers are a distinct semantic and bolting `open`/chevron onto
the generic row smears two concerns and muddies the lint message.

### File: `plugins/primitives/plugins/row/web/internal/section-header-row.tsx`

```tsx
export type SectionHeaderVariant = "eyebrow" | "title";
export interface SectionHeaderRowProps {
  open: boolean;                       // rotates chevron, feeds aria-expanded
  variant?: SectionHeaderVariant;      // "eyebrow" (default) | "title"
  actions?: React.ReactNode;           // trailing swatches / stats / headerExtra
  className?: string;
  children: React.ReactNode;
  [key: string]: unknown;              // onClick / passthrough
}
```
Renders `<Row as="button" aria-expanded={open} actionsAlwaysVisible
icon={<CollapsibleChevron open={open} className="size-4"/>} className={variantClass}>`:
- `eyebrow` → `"text-xs font-medium uppercase tracking-wider text-muted-foreground"`
  (cluster D's exact look) + `hover="muted"`. **All 7 byte-identical token-section headers
  collapse to one usage** — the highest-value consolidation:
  `<SectionHeaderRow open={open} actions={swatches} onClick={toggle}>Tokens</SectionHeaderRow>`
- `title` → `"text-sm font-semibold"` + `hover="muted"`. Bordered-card headers (cluster E:
  `define-detail-sections`, `backup-panel`) pass a `className="rounded-lg px-4 py-3"` override
  (safe — on the `<Row>` component).

Imports `CollapsibleChevron` from `@plugins/primitives/plugins/collapsible/web`. `open` is
passed explicitly (decoupled from `<Collapsible>` context) so it works standalone or nested.

---

## Part C — Refactor `TreeRowChrome` to compose `Row`

`tree-row-chrome.tsx` currently owns `group flex min-h-7 items-center gap-1 rounded px-1 py-1
text-sm hover:bg-accent` + `selected && bg-accent` + indent — all now `Row`. Refactor to render
`<Row as="div">`, keeping its custom chevron-button + leaf-spacer as the `icon` slot and
`min-h-7`/`gap-1` as `className` overrides:

```tsx
import { Row } from "@plugins/primitives/plugins/row/web";
import { CollapsibleChevron } from "@plugins/primitives/plugins/collapsible/web";

export function TreeRowChrome({ depth, hasChildren, isOpen, selected, onToggle, onSelect,
  children, actions, className, rowRef, indentStep = 16, leafChevron = true }: TreeRowChromeProps) {
  return (
    <Row as="div" ref={rowRef} hover="accent" selected={selected}
      indent={depth * indentStep + 4} onClick={onSelect} actions={actions}
      className={cn("min-h-7 gap-1", className)}    // tree geometry wins via cn() order
      icon={
        hasChildren || leafChevron ? (
          <button type="button" aria-label={isOpen ? "Collapse" : "Expand"}
            onClick={(e) => { e.stopPropagation(); onToggle?.(); }}
            className={cn("flex size-5 shrink-0 items-center justify-center rounded hover:bg-background/60",
              hasChildren ? "opacity-40 group-hover:opacity-100" : "opacity-0 group-hover:opacity-60")}>
            <CollapsibleChevron open={isOpen} className="size-4" />
          </button>
        ) : (<span className="size-5 shrink-0" aria-hidden />)
      }>
      {children}
    </Row>
  );
}
```

- **`RowChrome` (the DnD layer in `row-chrome.tsx`) needs no change.** It uses a *named* group
  `group/row` for the drag-handle; `Row`/`TreeRowChrome` use the *default* `group` for
  actions/chevron reveal — distinct Tailwind scopes, no collision. The drop ring
  (`r.isOverChild && "bg-accent ring-primary/40 ring-1"`) passes through `className`.
- **`row-chrome.tsx:134` inline "Add" `<button className="flex w-full … rounded px-1 py-1
  hover:bg-accent">`** is itself an ad-hoc row → migrate to `<Row>` (otherwise the rule flags it).
- **`ref` forwarding is the one hard dependency** — `Row` must forward `ref` to `<As>` or the
  tree's `rowRef` (DnD scroll + child-drop target) silently breaks.
- **Boundary/cycle:** `tree` → `@plugins/primitives/plugins/row/web` is a legal barrel import;
  `row` imports only `collapsible` + `web-sdk/core` + `@/lib/utils`, never `tree`. No cycle.

---

## Part D — Lint rule `row/no-adhoc-row`

### Files
- `plugins/primitives/plugins/row/lint/no-adhoc-row.ts`
- `plugins/primitives/plugins/row/lint/index.ts` → default
  `{ name: "row", rules: { "no-adhoc-row": rule }, ignores: { "no-adhoc-row": [] } }` (empty).

Repo-wide id `row/no-adhoc-row`. Mirror `badge/lint/no-adhoc-chip.ts` exactly: same
`createRule` header, same structural `collectTokens` walk (copy — lint rules don't cross-import;
the chip rule's comment establishes this duplication is accepted), same per-`className`
aggregation + host-tag gate.

### Fingerprint — the interactive complement of the chip rule

Fire when **ALL** present on an intrinsic `span/div/button/a`:
- rounded: `/^rounded(-|$)/`
- small px (exact): `{px-0.5, px-1, px-1.5, px-2, px-2.5, px-3}`
- small py (exact): `{py-px, py-0.5, py-1, py-1.5, py-2}`
- **interactive signal (≥1):** `w-full` **or** `text-left` **or** `/^hover:bg-/`

Skip (escape) when **ANY** present:
- positioned: `absolute` / `fixed` / `sticky` (overlays/sticky headers — cluster H escapes
  structurally, no marker needed)
- named-pad: `/^p-[a-z]/` (the `p-row`/`p-control`/`p-chip` token escape)

No auto-fix (choosing Row vs Button vs SegmentedControl, mapping props, adding imports is
unsafe to mechanize). **Host gate adds `a`** (chip rule used `{span,div,button}`; cluster F has
`<a>` link rows). Notes on bounds: px/py go wider than the chip rule (px→3, py→2) to catch tabs
(`px-3 py-1.5`) and ghost buttons; px-4/py-3 section headers need no coverage since they become
`<SectionHeaderRow>` components. The chip rule's narrower px(≤2)/py(≤1) + *excludes* signals;
the two never overlap.

### Message (single `messageId: "adhocRow"`)

> Ad-hoc interactive control (rounded + small px/py + `w-full`/`text-left`/`hover:bg-` on a
> span/div/button/a) — route through a primitive: `Row`/`SectionHeaderRow` (list, menu, nav,
> tree, and collapsible section-header rows), `Button`/`IconButton` (single actions), or
> `SegmentedControl` (tab / segment groups). If intentionally bespoke (positioned overlay,
> a primitive's own internals), render through a component, use a named padding token
> (`p-row`/`p-control`), or `// eslint-disable-next-line row/no-adhoc-row -- <reason>`.

### Leave `no-adhoc-chip` unchanged
Its exclusions (`w-full`/`hover:bg-`/`text-left`/positioned/named-pad) are what make the two
rules a clean partition. Removing them would make the chip rule flag rows with the *wrong*
("use Badge") message and double-flag. Keep as-is.

### Sanctioned-primitive internals that newly trip the rule → marker

After migration the only remaining intrinsic matches are primitives that *define* the shape:
- **`Row`/`SectionHeaderRow`** — escape via `p-row` (named-pad). No marker.
- **`ToggleChip`** (`toggle-chip.tsx`, `rounded-full px-3 py-1`/`px-2 py-0.5` + `hover:bg-`) —
  **adopt `p-control` (md) + `p-chip` (sm)** so it escapes cleanly (preferred — also dogfoods
  the density tokens), or one inline-disable. Implementer's call; prefer token adoption.
- **`define-tabbed-view.tsx:77`** internal tab button — its own primitive's internals; one
  inline-disable `// … -- tabbed-view's own tab control` (its `flex-1 justify-center` layout
  differs from `SegmentedControl`, so it stays bespoke).

---

## Part E — Migration mapping (~60 sites, one atomic change)

Source: the full 78-site catalog (clusters A–J). In/out per cluster:

| Cluster | ~N | Target | In scope |
|---|---|---|---|
| A plain hover row | 9 | `Row` (no `selected`) | ✅ |
| B selectable nav row | 10 | `Row selected` | ✅ |
| C popover menu item | 9 | `Row size="sm" hover="muted"` | ✅ |
| D token section header (xs uppercase) | 7 | `SectionHeaderRow variant="eyebrow"` | ✅ (highest value) |
| E general section header (sm semibold) | 6 | `SectionHeaderRow variant="title"` | ✅ |
| F link/icon row (`<a>` / open-pane) | 5 | `Row as="a"` / `Row` | ✅ |
| G bordered chip-row | 4 | `Row bordered actionsAlwaysVisible` | ✅ |
| ghost action buttons | 8 | `Button variant="ghost" size="xs"` / `IconButton` | ✅ |
| tab strips (queue-view, review/source) | 2 | `SegmentedControl` (existing) | ✅ |
| display-only hover `div`s | 3 | `Row as="div"` (no onClick) | ✅ |
| J `li` rows (bell-button) | 1 | `Row as="li"` (optional — `li` not gated, not forced) | �ðŸ”¸ optional |
| H sticky file-diff rows | 3 | keep raw (escape via `sticky`) — or `<Row className="sticky…">` | ⬜ structural escape |
| `define-tabbed-view` internal tab | 1 | inline-disable (primitive internals) | ✅ marker |
| `ToggleChip` internals | 1 | adopt `p-control`/`p-chip` token | ✅ |
| HTML `<tr>` rows | 2 | none (`tr` not gated) | ⬜ |
| fixed-geometry rows (commit-list, publish tree) | 2 | none (no `rounded`/`px`) | ⬜ |

Plus the `TreeRowChrome` refactor (§C) and `row-chrome.tsx`'s inline "Add" button.

**Visual-consolidation caveats** (call out in PR description, same as the chip plan):
- **Padding → one row density (`p-row`, 8×6px).** Catalog px-1..4 / py-0.5..3 collapse; pixel
  shifts. `min-h-*` overrides preserve height where it matters (tree).
- **Hover normalization.** `hover:bg-muted/30|40|60|80` → `hover:bg-muted/50`; ad-hoc
  `hover:bg-accent/50` → `hover:bg-accent` (via the `hover` enum).
- **Gap.** gap-1/1.5/3 → gap-2 (tree keeps gap-1 via override).
- **Ghost buttons** picking up `Button` geometry (`h-6`, focus ring) — minor look change;
  soft-colored ones (config destructive/warning) keep their bg via `className`/variant.

---

## Critical files

**Create**
- `plugins/primitives/plugins/row/web/internal/row.tsx`
- `plugins/primitives/plugins/row/web/internal/section-header-row.tsx`
- `plugins/primitives/plugins/row/web/index.ts`
- `plugins/primitives/plugins/row/lint/no-adhoc-row.ts`
- `plugins/primitives/plugins/row/lint/index.ts`
- `plugins/primitives/plugins/row/package.json`

**Modify**
- `plugins/primitives/plugins/tree/web/internal/tree-row-chrome.tsx` (compose `Row`)
- `plugins/primitives/plugins/tree/web/internal/row-chrome.tsx` ("Add" button → `Row`)
- `plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx` (adopt `p-control`/`p-chip`)
- `plugins/apps/plugins/forge/.../tabbed-view`… → `plugins/primitives/plugins/tabbed-view/web/internal/define-tabbed-view.tsx` (inline-disable)
- ~60 migration call sites across clusters A–G + ghost buttons + tabs (catalog enumerates each)

**Reference (do not modify)**
- `plugins/primitives/plugins/badge/lint/no-adhoc-chip.ts` (rule template)
- `plugins/primitives/plugins/toggle-chip/web/internal/toggle-chip.tsx` (API template)
- `plugins/framework/plugins/web-core/web/theme/app.css:280-282` (`p-row`/`p-control`/`p-chip`)
- `plugins/framework/plugins/web-core/web/components/ui/button.tsx` (`Button` variants/sizes)
- `plugins/primitives/plugins/icon-button/web/index.ts`, `.../toggle-chip/web` (`SegmentedControl`)

---

## Verification

1. `./equin build` — codegen discovers `row/web/index.ts` + `row/lint/index.ts` →
   regenerates `lint.generated.ts` (`row/no-adhoc-row` registered `error` repo-wide) and
   `plugins/primitives/CLAUDE.md`. `plugins-registry-in-sync` / `plugins-doc-in-sync` confirm.
2. `./equin check --eslint` — must pass **green with empty `ignores`**; only passes once
   every in-scope site is migrated or marked. Run iteratively during migration. Confirm both
   `row/no-adhoc-row` and `badge/no-adhoc-chip` are `error`.
3. **Negative tests** (scratch component, then revert):
   - `<button className="flex w-full items-center rounded px-2 py-1 text-left hover:bg-accent">` → flagged.
   - replace with `<Row>` → not flagged (component host skipped).
   - ghost `<button className="rounded px-2 py-1 hover:bg-accent">` (no w-full/text-left) → flagged (→ Button).
   - `<Badge>` / `p-row` user / a `sticky` row → not flagged.
4. `./equin check` (full) — type-check `ref` forwarding on `Row` and that
   `TreeRowChrome.rowRef` still satisfies the DnD `childRef` type; all checks green.
5. **Playwright** before/after (`e2e/screenshot.mjs`) on representative surfaces: file-tree
   (`code-explorer`, TreeRowChrome path), tasks-recent (cluster B), token section headers
   (typography/shadow/shape, cluster D), a popover menu (`page-link-block`/`category-chip-toolbar`,
   cluster C), an agent-launches/task-events bordered row (F/G), and a migrated ghost button +
   `SegmentedControl` tab strip. Confirm hover, selected, hover-revealed actions, and that the
   density/hover normalization is acceptable.

## Risks

- **`ref` forwarding (highest).** `Row` must forward `ref` (ToggleChip/Badge don't); the tree
  DnD depends on it. The one intentional API divergence from ToggleChip.
- **Atomic red window.** Empty `ignores` ⇒ red until migration completes; land as one change
  (or stage so CI never sees red). Accepted, per the user's atomic decision.
- **`ToggleChip` token adoption** subtly shifts its padding (`px-3 py-1` → `p-control` 12×6).
  Minor; the alternative is one inline-disable.
- **Scope (~60 sites).** Large diff. Mitigated by the catalog enumerating every site and by
  most migrations being mechanical prop-mapping; the chip plan landed 53 sites the same way.
