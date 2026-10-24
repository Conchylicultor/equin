# Popover width & padding roles

## Context

A view-settings popover rendered misaligned (content overflowing its padded panel).
Root cause: **width was declared in two places**. `editable-view-switcher.tsx` passed
`contentClassName="w-72"` to `InlinePopover`, and the body
(`view-settings-popover.tsx`) root `<Stack>` *also* set `className="w-72"`. Because
`PopoverContent` bakes in `p-md`, the inner rigid 18rem child overflowed the padded
18rem panel.

The bug is an instance of a wider pattern: **~40 popover/menu call sites hand-set a
fixed Tailwind width** (`w-48`…`w-96`, plus arbitrary `w-[480px]`/`w-[640px]`), often
with a padding override (`p-sm`/`p-xs`/`p-none`, even raw `p-2`/`p-1`) on the same
string, and occasionally restated by the body. Width is a magic number sprinkled per
call site instead of an owned role, so double-declaration and overflow are
representable.

This plan makes **width and padding typed roles owned by the popover primitive**, maps
every existing seam width onto a closed named ramp, and migrates all call sites. Bodies
stop declaring width. A scoped lint to *forbid* re-introducing fixed widths is
explicitly **deferred** (separate, later) — this round removes the *reason* and
normalizes the call sites; the lint will later remove the *capability*.

**Out of scope (separate task `task-1782144389794-lv4pjj`):** the 5 caret-anchored
Lexical menus (`slash-menu`, `inline-math`, `inline-date`, `inline-page-link`,
`url-paste`) that bypass the primitive entirely with hand-rolled `fixed` + inline
`style`. They need a virtual-anchor capability, planned independently.

**Also out of scope:** `DropdownMenuContent` (its base `w-max min-w-[max(8rem,
--anchor-width)]` is already a good menu default), dialog modal widths
(`max-w-lg`/`max-w-4xl` — a distinct modal-sizing role), and `SheetContent`.

## Design

### Width vocabulary (closed ramp)

A named role mapped to a class, mirroring `SURFACE_LEVELS`
(`ui-kit/web/theme/surface.ts`) — a module-level `Record<Name, string>` indexed by a
plain prop, no Context.

| Token | Class | Width | Replaces |
|---|---|---|---|
| `content` | *(none)* | size-to-content | `w-auto`, no-width (**default**) |
| `xs` | `w-48` | 12rem / 192px | `w-48` |
| `sm` | `w-56` | 14rem / 224px | `w-56`, `w-60` |
| `md` | `w-64` | 16rem / 256px | `w-64` |
| `lg` | `w-72` | 18rem / 288px | `w-72` |
| `xl` | `w-80` | 20rem / 320px | `w-80` |
| `2xl` | `w-96` | 24rem / 384px | `w-96`, `w-[24rem]`, `w-[26rem]` |
| `3xl` | `w-[30rem]` | 30rem / 480px | `w-[420px]`, `w-[480px]` |
| `4xl` | `w-[40rem]` | 40rem / 640px | `w-[640px]` |

- **Fixed width, not min/max** — a stable, predictable form panel is the whole point.
- **Viewport-safe by construction**: every non-`content` token also gets
  `max-w-(--available-width)` (base-ui's Positioner exposes this CSS var on the popup;
  already used in `dropdown-menu.tsx`). This **replaces** the ad-hoc `max-w-[90vw]`
  that filter/sort/raw-json carry today, so no popover can overflow a narrow viewport.
- **Default `content`** — non-breaking: matches base-ui's current size-to-content
  behavior for the ~6 no-width / `w-auto` sites (menus, track-mixer, task-draft).
  Forms opt into a fixed width explicitly.
- **Roundings to confirm during migration** (snapped to the ramp): `w-60`→`sm`
  (15→14rem), `w-[420px]`→`3xl` (420→480px), `w-[26rem]`→`2xl` (26→24rem).

### Padding role (separate axis)

Padding becomes its own typed prop so it is never entangled with width on a free-form
string. Maps to the existing `p-*` `@utility` classes (owned by `app.css` in ui-kit).

| Token | Class | Replaces |
|---|---|---|
| `none` | `p-none` | `p-none` |
| `2xs` | `p-2xs` | raw `p-1` |
| `xs` | `p-xs` | `p-xs`, raw `p-2` |
| `sm` | `p-sm` | `p-sm` |
| `md` | `p-md` | `p-md` (**default** — preserves current baked-in padding) |
| `lg` | `p-lg` | — |

`p-md` is **removed from the static class string** in `PopoverContent` and driven by
the `padding` prop (default `md`), so behavior is unchanged when omitted. Raw `p-2`/`p-1`
roundings (`xs`/`2xs`) to be eyeballed during migration.

### Prop surface

**`PopoverContent`** (`ui-kit/web/components/ui/popover.tsx`) — gains:
```ts
width?: PopoverWidth     // default "content"
padding?: PopoverPadding // default "md"
```
Applied via `cn(SURFACE_LEVELS.overlay, "<animations/z/outline>",
POPOVER_WIDTH[width], POPOVER_PADDING[padding], className)`. The static `p-md` is
dropped from the string. `className` stays **last** for non-width/non-padding tweaks
(`space-y-3`, `flex-col`, `min-w-0`). This covers both direct `PopoverContent`
consumers (avatar/callout/page-icon/change-cover/exit-commit) and `InlinePopover`.

**`InlinePopover`** (`popover/web/internal/inline-popover.tsx`) — gains `width` +
`padding` passthrough props forwarded to `PopoverContent`. `contentClassName` is
**retained** for genuine non-width/padding classes but documented as "must not carry
width or padding" (the deferred lint enforces this). The width-bearing `contentClassName`
usages are all migrated away.

**Body fills**: bodies that restate width drop it. Concretely
`view-settings-popover.tsx` root `<Stack gap="md" className="w-72">` →
`<Stack gap="md">` (a flex/block child fills the padded panel automatically — no
explicit `w-full` needed). `launch-agent-popover.tsx`'s `width: string` prop
(default `"w-[420px]"`) becomes a `PopoverWidth` (`3xl`).

### Where the role map lives

New file `ui-kit/web/theme/popover-width.ts` (sibling of `surface.ts` /
`control-size.tsx`), exporting `PopoverWidth`, `PopoverPadding`, `POPOVER_WIDTH`,
`POPOVER_PADDING`. Re-exported from the ui-kit barrel so the `popover` primitive
(already a ui-kit consumer) can import the types — boundary-legal.

> **Residual gap (intentional):** the primitive alone does not *prevent* a future body
> from writing `className="w-72"` again, nor does it cover the 5 raw caret menus. That
> is exactly why the scoped lint (deferred) and the caret-anchor task exist. This plan
> closes the common path and normalizes all current sites.

## Files to modify

**Primitive (3 files):**
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/popover-width.ts` — **new**: the two records + types.
- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/popover.tsx` — add `width`/`padding` props; drop static `p-md`; index the maps.
- `plugins/primitives/plugins/css/plugins/ui-kit/web/index.ts` — re-export the new types.
- `plugins/primitives/plugins/popover/web/internal/inline-popover.tsx` — add `width`/`padding` passthrough; doc `contentClassName`.

**Migration — InlinePopover `contentClassName` → `width`/`padding` props** (file → tokens):

| File | width | padding |
|---|---|---|
| `primitives/data-view/view-core/.../editable-view-switcher.tsx` (+ body `view-settings-popover.tsx` drop `w-72`) | `lg` | (md) |
| `primitives/folder-picker/.../folder-picker-popover.tsx` | `xl` | `none` |
| `shell/notifications/.../bell-button.tsx` | `xl` | `none` |
| `fields/tags/inline/.../tags-editor.tsx` | `md` | (md) |
| `build/.../build-button.tsx` | `3xl` | `none` |
| `conversations/conversation-preprompt/.../preprompt-chip.tsx` | `xl` | `sm` |
| `fields/enum/inline/.../enum-editor.tsx` | `xs` | (md) |
| `fields/date/filter/.../date-filter.tsx` | `md` | (md) |
| `primitives/launch/.../launch-agent-popover.tsx` (`width` prop → `PopoverWidth`) | `3xl` | `md` |
| `build/build-fix/.../build-fix-section.tsx` (via LaunchAgentPopover) | `3xl` | `md` |
| `improve/element-picker/.../ui-context-chip.tsx` | `xl` | (md) |
| `conversations/conversation-category/.../category-chip-toolbar.tsx` | `sm` | `xs` |
| `primitives/data-view/.../filter/chip-select-filter-input.tsx` | `md` | (md) |
| `primitives/data-view/.../filter/filter-builder-trigger.tsx` (drop `max-w-[90vw]`) | `2xl` | (md) |
| `primitives/data-view/.../filter/field-picker.tsx` | `lg` | (md) |
| `primitives/data-view/.../filter/add-filter-affordance.tsx` | `lg` | (md) |
| `apps/sonata/track-mixer/.../track-mixer-panel.tsx:63` | `content` | `sm` |
| `apps/sonata/track-mixer/.../track-mixer-panel.tsx:139` | `sm` | `sm` |
| `primitives/data-view/.../sort/presets/save-preset-affordance.tsx` | `md` | (md) |
| `primitives/data-view/.../sort/add-sort-affordance.tsx` | `lg` | (md) |
| `primitives/data-view/.../sort/sort-builder-trigger.tsx` (drop `max-w-[90vw]`) | `2xl` | (md) |
| `apps/sonata/piano-roll/.../fx-toggle.tsx` | `sm` | `sm` |
| `conversations/.../dependencies/dependencies-button.tsx` (×2) | `2xl` | `sm` |
| `conversations/.../branch/branch-buttons.tsx` | `3xl` | (md) |
| `conversations/.../jsonl-viewer/raw-json-button.tsx` (drop `max-w-[90vw]`) | `4xl` | `none` |
| `apps/studio/compositions/.../entry-editor.tsx` | `xl` | (md) |
| `reorder/web/internal/dnd-list-middleware.tsx` (raw `p-2`) | `lg` | `xs` |
| `reorder/editor/web/internal/items.tsx` | `sm` | `none` |
| `config_v2/settings/.../scope-tabs.tsx` (raw `p-1`) | `sm` | `2xs` |
| `page/page-link/.../page-link-block.tsx` | `lg` | `sm` |
| `page/math/inline/.../inline-math-node.tsx` | `lg` | `sm` |
| `page/formatting/color/.../color-button.tsx` | `sm` | (md) |
| `page/formatting/link/.../link-button.tsx` | `lg` | (md) |
| `page/editor/.../block-actions-menu.tsx` | `sm` | `xs` |
| `page/editor/.../block-type-menu.tsx` (default prop) | `sm` | `xs` |

**Migration — direct `PopoverContent className` → `width`/`padding` props:**

| File | width | padding |
|---|---|---|
| `page/callout/.../callout-icon.tsx` | `xl` | `sm` |
| `reorder/edit-mode/.../exit-commit-popover.tsx` | `md` | (md) |
| `apps/pages/page-tree/.../page-icon-button.tsx` | `xl` | `sm` |
| `apps/pages/page-tree/.../change-cover-popover.tsx` | `xl` | `sm` |
| `primitives/avatar/.../avatar-picker.tsx` | `xl` | `sm` |
| `primitives/css/color-picker/.../color-picker-popover.tsx` (keep caller `contentClassName` passthrough) | `content` | `none` |
| `primitives/pane/.../pane-chrome.tsx` (keep `min-w-0` in `className`) | `content` | `xs` |

No-change (already `content`-equivalent, no width): `tasks/task-draft-form/.../task-draft-popover.tsx`.

## Verification

1. `./equin build` from the worktree; confirm no type errors (the new
   `PopoverWidth`/`PopoverPadding` unions are exhaustively checked at every call site).
2. Reproduce the original bug: open `http://<worktree>.localhost:9000/pages`, click the
   active **Tree** view chip → the settings popover must render with content filling the
   padded panel (no overflow, focus ring not clipped). Use
   `bun e2e/screenshot.mjs` to capture before/after.
3. Spot-check a sample across the ramp: a menu (`block-type-menu`, `content`/`sm`), a
   wide panel (`raw-json-button`, `4xl`/`none`), a `p-none` list (`bell-button`), and a
   `content` auto-width (`track-mixer`). Confirm widths visually match pre-migration and
   none overflow a narrowed window (the baked `max-w-(--available-width)` cap).
4. `git diff $(git merge-base HEAD main)` to confirm no stray `w-XX` width strings
   remain on popover/`PopoverContent` content props (the migration is complete).
