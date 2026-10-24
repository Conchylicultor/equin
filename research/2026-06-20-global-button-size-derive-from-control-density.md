# Button derives size from ambient control density (Phase 2: Button)

## Context

This is **Phase 2** of an arc the user is driving: **size stops being a
per-element property and becomes a property of the region.** You declare *where
you are* (a table, a toolbar, a card, a pane) via one ambient `ControlSize`, and
every leaf inside auto-infers its size from it — so a single control *cannot*
desync from its neighbors, because there is no per-instance dial left to set
wrong.

Phase 1 (`research/2026-06-20-global-chip-size-derive-from-control-density.md`)
removed the per-instance `size` prop from the chip family (`Badge`,
`ToggleChip`, `SegmentedControl`) and migrated `IconButton`/`PaneIconAction` —
all now derive size solely from `useControlSize()`.

`Button` is the **last** control that still accepts an explicit per-instance
`size` that can diverge from its container's density (~80 call sites pass it by
hand). This makes mixed containers impossible to keep consistent — e.g. in
Debug → Queue a status `Badge` sits beside `Retry`/`Cancel` buttons, and setting
one ambient density can't align them because the buttons are sized
independently. Phase 2 closes that hole.

The subtlety unique to Button: its `size` enum **conflates two orthogonal axes**
— *density* (height: `xs`/`sm`/`md`/`lg`) and *aspect/shape* (text vs square
`icon` vs `inline`). Density is a regional property (must become ambient);
aspect is a genuine per-instance shape decision a bare `<Button>` cannot infer.
So unlike the chips, Button can't simply drop `size` — it must **split** the
axes: density goes ambient, aspect becomes an explicit `aspect` prop.

## Desired invariant

`Button` derives its **density** (height) solely from the container's ambient
control density (`ControlSizeProvider` / `useControlSize`), with **no
per-instance `size` override that can diverge** — enforced by the type system
(passing `size` is a compile error), not by review. **Shape** (text / icon /
inline) is selected via an explicit `aspect` prop, which carries no density.

## Decisions (confirmed with user)

1. **Shape axis = new `aspect` prop** — `aspect?: "text" | "icon" | "inline"`
   (default `"text"`), a closed enum. Not two booleans (which would make the
   illegal `icon inline` combo representable).
2. **Pure normalize, defer all to Phase 3** — mirror Phase 1 exactly: strip
   `size=` everywhere and let buttons fall to ambient density. Do **not** add any
   `ControlSizeProvider` in this phase (not even for dense panes like
   Debug → Queue). Per-region density is Phase 3's job; the interim normalization
   (some `sm`/`xs` buttons render taller at default `md`) is accepted.

## Existing mechanism to reuse

- `useControlSize()` / `ControlSizeProvider` / `ControlSize`
  (`"xs"|"sm"|"md"|"lg"`, default `"md"`),
  `iconSizeFor(size): "icon-xs"|"icon-sm"|"icon"|"icon-lg"`, and the identity
  seam `textSizeFor(size): ControlSize` — all in
  `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size.tsx`.
- **`IconButton` is the exact precedent**
  (`plugins/primitives/plugins/icon-button/web/components/icon-button.tsx`):
  `Omit<ComponentProps<typeof Button>, "size">` + computes
  `iconSizeFor(useControlSize())`. Button mirrors the `Omit<…,"size">` half.
- `Button` already calls `useControlSize()` and does
  `const resolvedSize = size ?? textSizeFor(density)` — Phase 2 only removes the
  `size ??` override path and adds the aspect branch.
- Button has **no** `[key:string]: unknown` index signature (its props are
  `ButtonPrimitive.Props & VariantProps & {loading?}`), so a structural
  `Omit<…,"size">` fully removes `size` — no `size?: never` sentinel needed
  (that was only required for Badge/ToggleChip because of their index leak).

## Changes

### 1. Button — `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/button.tsx`

- **Keep the `buttonVariants` cva block unchanged.** All `size` keys
  (`xs/sm/md/lg/default/icon/icon-xs/icon-sm/icon-lg/inline`) stay as **internal**
  targets fed by `resolvedSize`. Do not prune them.
- **Remove `size` from the public surface, add `aspect`:**
  ```ts
  type ButtonOwnProps = ButtonPrimitive.Props &
    Omit<VariantProps<typeof buttonVariants>, "size"> &
    { aspect?: "text" | "icon" | "inline"; loading?: boolean }
  ```
  (`shape` — the `default|pill` radius axis — stays public and untouched.)
- Import `iconSizeFor` alongside the existing `useControlSize` / `textSizeFor`.
- Replace the `size` destructure with `aspect = "text"`, and replace
  `const resolvedSize = size ?? textSizeFor(density)` with the three-way resolver:
  ```ts
  const density = useControlSize()
  const resolvedSize =
    aspect === "inline" ? "inline"
    : aspect === "icon"  ? iconSizeFor(density)
    : textSizeFor(density)
  ```
- Update the comment at lines 80-82 to describe the new model (density is
  ambient; `aspect` selects shape) instead of "Icon shape is the wrapper's job …
  Explicit `size` always wins."
- Leave `loading`/auto-pending and the `iconOnly =
  resolvedSize.startsWith("icon")` logic untouched (`aspect="icon"` still
  produces an `icon*` key, so `iconOnly` stays correct).

Net effect: `Omit<…,"size">` makes any `<Button size=…>` a **compile error**
(`size` is not a member of `ButtonOwnProps`), so `./equin check type-check`
enumerates every remaining call site — none can be missed.

### 2. Wrapper migrations (forward `size` to Button → must change)

**a. `IconButton`** —
`plugins/primitives/plugins/icon-button/web/components/icon-button.tsx`. Drop the
local `useControlSize` + `iconSizeFor` computation and pass `aspect="icon"` to
`Button`. Rendering is identical: IconButton adds no provider between itself and
Button, so Button reads the same ambient density and computes `iconSizeFor(D)`
internally. Keep the existing `Omit<…,"size">` on `IconButtonProps`.

**b. `CopyButton`** —
`plugins/primitives/plugins/copy-to-clipboard/web/internal/copy-button.tsx`.
Replace its `size?: "icon"|"icon-xs"|"icon-sm"|"icon-lg"|"inline"` (default
`"icon"`) with `aspect?: "icon" | "inline"` (default `"icon"`), forwarded as
`aspect`. Drops per-instance icon density (now ambient). Callers:
- `auth/google/.../google-setup-pane.tsx` — no size → no edit.
- `page/code-block/.../code-block.tsx` — `size="icon-sm"` → remove (ambient).
- `primitives/filepath-breadcrumb/.../filepath-breadcrumb.tsx` — `size="inline"` → `aspect="inline"`.
- `review/.../file-changes-section.tsx` — `size="inline"` → `aspect="inline"`.
- `review/code-review/.../review-file-row.tsx` — `size="inline"` → `aspect="inline"`.
- `code-explorer/.../file-path.tsx` — `size="inline"` → `aspect="inline"`.

**c. `GrantAccessButton`** — `plugins/auth/web/components/grant-access-button.tsx`.
Delete its `size?: "sm"|"default"` prop + default; render `<Button>` with no
size. Both callers (`scope-grant-notice.tsx`, `backup/.../backup-panel.tsx`) pass
no size, so dropping the prop is non-breaking.

**d. `LaunchControl`** —
`plugins/primitives/plugins/launch/web/components/launch-control.tsx` (a 4th
wrapper not in the original brief). It forwards raw `size` to several `<Button>`s
and will break type-check. Migrate: internal `size="icon-xs"` trigger buttons →
`aspect="icon"`; the text-path `btnSize = size === "sm" ? "sm" : "default"` →
strip the forwarded size (ambient). Narrow LaunchControl's own prop so its `"sm"`
density meaning is removed — keep only the icon-vs-text **aspect** selection
(`size?: "default" | "icon"`, or rename to match). Its callers passing
`size="icon"` keep the icon aspect; callers passing `size="sm"`
(`prompt-form.tsx`, `conversation-list.tsx`) lose the small density (normalize).

### 3. Direct `<Button>` call-site migration (driven by type-check)

After the prop change, `./equin check type-check` lists every offending
site. Two buckets:

- **Icon-shaped** (`size="icon"` / `"icon-sm"` / `"icon-xs"`, ~11 sites — custom
  children, dropdown/`render` triggers, `className="size-N"` boxes, non-ghost
  variants; **stay on Button**, do not fold into IconButton) → replace with
  `aspect="icon"`. Includes ui-kit internals `sidebar.tsx` (`SidebarTrigger`) and
  `sheet.tsx` (`SheetClose`), plus worktree-cleanup, broadcasts, memory, build-*,
  exit-menu, resume, notes-toggle, new-child-task, row-action-button, task-graph
  edge-actions, reorder dnd-list-middleware, task-description pin, etc.
- **Text-shaped** (`size="sm"` / `"xs"` / `"lg"` / `"default"`, the majority) →
  **strip the `size=` attribute** (normalize to ambient density). No
  `ControlSizeProvider` added (per the pure-normalize decision).

Trust the compiler, not grep — `rg` for `size="sm"` also hits non-Button
components (`SidebarMenuButton`, `status-dot`, `bouncing-dots`, …) that keep their
own `size`. Iterate type-check to zero.

### 4. Test

`plugins/primitives/plugins/css/plugins/ui-kit/web/__tests__/button-loading.test.tsx`
passes `size="icon-sm"` → change to `aspect="icon"`. The loading-spinner
assertion keys off the resolved `icon*` size, which `aspect="icon"` still
produces.

### 5. Docs

- **`.claude/skills/theme/SKILL.md`** §"Control size = density inherited from
  context": update so `Button` is listed among the controls that derive density
  purely from ambient `ControlSize` (no `size` prop); note shape is chosen via
  `aspect`. Remove any "explicit `size` is the escape hatch" wording for Button —
  there is no longer a per-instance density hole anywhere.
- **`plugins/primitives/plugins/css/plugins/control-size/CLAUDE.md`**: same
  correction — `Button` now derives density from ambient context; `aspect`
  selects shape.
- **`plugins/primitives/plugins/css/plugins/ui-kit/CLAUDE.md`**: the `ControlSize`
  bullet — mention `Button` reads density from context and chooses shape via
  `aspect` (the hand-written prose; the autogen "Plugin reference" block
  regenerates via build).
- **`.claude/skills/css/SKILL.md`** "Mental model": Phase 1 already added the
  "size/density is a region property, never a per-element prop" bullet — extend it
  to note `Button` now obeys it too (the last hold-out is closed).
- Autogen CLAUDE.md "Plugin reference" blocks (icon-button, copy-to-clipboard,
  ui-kit, auth, launch) and any `package.json` description that feeds them →
  **do not hand-edit**; `./equin build` regenerates them (it will pick up
  the dropped `iconSizeFor`/`useControlSize` deps on icon-button and the changed
  CopyButton/GrantAccessButton/LaunchControl prop types).

### 6. Enforcement

No new lint rule. Props are tsc's domain: removing `size` from `ButtonOwnProps`
makes a regression a **compile error**, caught by the `type-check` check (which
runs in `build` and `push`). The existing `no-adhoc-control`
(`…/control-size/lint`) covers ad-hoc `control-*` height classes and is
unaffected.

## Follow-up (already filed as Phase 3)

**Phase 3 — region primitives own density.** Bake intrinsic density into the
region primitives (`Bar`, `Card`, `data-table`, pane toolbars) via
`defineRenderSlot(id, { controlSize })` auto-wrap, so a `<Table>` *is* compact
and a toolbar *is* `sm` without hand-written `ControlSizeProvider`. This is where
the dense panes whose buttons normalized in Phase 2 (Debug → Queue, broadcasts,
worktree-cleanup, task-graph edge clusters) regain their compact density —
declared once at the region, not per button.

## Verification

1. `./equin build` — regenerates autogen docs + runs checks; must pass.
2. `./equin check type-check` — must be clean. **This is the proof every
   `size=` call site was migrated**: any leftover `<Button size=…>` is a compile
   error. Treat each error as an un-migrated site, never cast it away.
3. `./equin check` (full) — lint (`no-adhoc-layout`, `no-adhoc-control`,
   spacing) must still pass; the `aspect` rename touches no layout/height classes.
4. Run the button test + any IconButton/CopyButton tests:
   `bun run test:dom plugins/primitives/plugins/css/plugins/ui-kit`.
5. Screenshot to confirm shapes/sizes are preserved where intended and the
   accepted normalization reads fine (use `bun e2e/screenshot.mjs`):
   - **Debug → Queue** (`http://<wt>.localhost:9000/agents` → Debug → Queue):
     confirm Retry/Cancel buttons now align in density with the neighboring status
     `Badge` (the motivating case); they render at the normalized `md` height.
   - A **conversation view** toolbar (resume / notes / exit-menu / new-child-task
     icon buttons) — confirm icon squares render at the same visual size as before.
   - An **inline `CopyButton`** (filepath breadcrumb / code-review file row) —
     confirm `aspect="inline"` copy glyphs are unchanged.
   - A `LaunchControl` (prompt form / conversation list) — split model+launch
     control still renders correctly.

## Critical files

- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/button.tsx` (core seam)
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/control-size.tsx` (reused; no change expected)
- `plugins/primitives/plugins/icon-button/web/components/icon-button.tsx`
- `plugins/primitives/plugins/copy-to-clipboard/web/internal/copy-button.tsx`
- `plugins/auth/web/components/grant-access-button.tsx`
- `plugins/primitives/plugins/launch/web/components/launch-control.tsx`
- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/sidebar.tsx`, `…/ui/sheet.tsx` (ui-kit internals)
- `plugins/primitives/plugins/css/plugins/ui-kit/web/__tests__/button-loading.test.tsx`
- ~70 direct call-site files (strip text `size=`; icon `size=` → `aspect="icon"`; full list via type-check)
- `.claude/skills/theme/SKILL.md`, `.claude/skills/css/SKILL.md`,
  `plugins/primitives/plugins/css/plugins/control-size/CLAUDE.md`,
  `plugins/primitives/plugins/css/plugins/ui-kit/CLAUDE.md`
