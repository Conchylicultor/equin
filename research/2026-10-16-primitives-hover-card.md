# Hover card — rich hover content with one style

## Context

`WithTooltip` (primitives/overlay/tooltip) → ui-kit `TooltipContent` is a
one-line label: `rounded-md`, `px-md py-xs`, `max-w-xs`, content in a centred
`inline-flex` row, centred on the trigger at a 4px offset, with an arrow. Rich
hover content is pushed through it anyway, each call site re-deciding width and
inner layout (`className="max-w-72"` in PickerPill, `max-w-md` in
dependencies-button and prototype-thumbnail, a hand-built `Stack` of `Text` in
`WorkspaceInfo` and `CommitLinkChip`). The result reads as ad hoc.

The first case is the workspace menu's per-row card (`PickerPill.Item info` →
`conversations/workspace/plugins/launch-option/web/components/workspace-info.tsx`).
The approved mock `proto-1789901373-oy29` (`.infocard`) shows:

- the menu's panel look (bg, border, shadow, 12px radius) at a fixed ~250px width
  and no arrow;
- placed **beside the menu**, 6px off, its top level with the hovered row
  (flipping to the other side if there's no room, clamped to the viewport);
- a title (600 weight) with the id inline as small faint mono `code`;
- a muted description;
- capability chips, where the missing ones are outlined, faint and struck through;
- a faint mono footer (`owner · N MCP tools`).

Goal: a primitive that takes **structured content as data** and owns all of the
chrome, layout and anchoring. That way a call site has no way to hand-roll card
styling (rung 1 of the ladder: it can't be written at all).

## Design

### 1. New plugin `primitives/overlay/hover-card` (web)

This is a sibling of `tooltip` and `hover-popover`. Tooltip stays the one-line
label. Hover-popover stays the *interactive* hover panel. The hover card is
non-interactive, with describe-style semantics (`aria-describedby`, like a
tooltip).

```ts
export interface HoverCardContent {
  title: ReactNode;
  /** An identifier shown inline after the title, as code. */
  code?: string;
  description?: ReactNode;
  /** Facets the subject has, or (off) lacks — lacking ones struck through. */
  chips?: readonly { label: string; off?: boolean }[];
  /** Why it can't be used right now — a warning line. */
  notice?: string;
  /** Provenance footer parts, joined with " · " in mono. */
  meta?: readonly string[];
}

export interface WithHoverCardProps {
  card: HoverCardContent;
  /**
   * `trigger` (default): beside the trigger, top-aligned.
   * `panel`: beside the overlay panel the trigger sits in (a menu row's card),
   *          its top level with the trigger.
   */
  beside?: "trigger" | "panel";
  side?: "right" | "left";   // preferred side; flips on collision
  children: ReactElement;
}
```

There's no `className` prop and no `ReactNode` body slot. The card's look comes
from the data shape alone. A new kind of row (say a key/value list) is added as
a new optional field in this primitive, never as call-site markup.

**Rendering.**

- **State machine.** base-ui `Tooltip` (the hover delay, the shared
  `TooltipProvider` delay group so moving between rows switches instantly,
  Esc/blur, describe semantics). A thin `HoverCardPopup` is added in ui-kit
  next to `TooltipContent`. It renders the `Tooltip.Popup` **as `OverlayPanel`**
  through `render`, the same way `DropdownMenuContent` does. So the card *is*
  the menu panel: same paint, radius, shadow and animation, by construction
  rather than copied classes. It has no arrow. It sets `scroll={false}`, uses a
  new width role `card`, and `padding="sm"`.
- **Width role `card`.** Added to `POPOVER_WIDTH` in
  `ui-kit/web/theme/popover-width.ts`, backed by a density token
  `popoverWidthCard` (default 256px). It's a role and not `md` because the
  ramp's own rule says a panel is sized by what it is. A theme can then size
  every hover card at once.
- **Anchoring `beside="panel"`.** `OverlayPanel` stamps a stable
  `data-overlay-panel` on its root. When the card opens, the positioner gets a
  base-ui virtual `anchor` whose rect is
  `{ left/right: panel rect, top/height: trigger rect }`, from
  `trigger.closest("[data-overlay-panel]")`. The settings are `side="right"`,
  `align="start"`, `sideOffset` = the menu gap token, and the default collision
  flip and shift. That gives "beside the menu, level with the row" with no
  coordinate maths at the call site. If the trigger has no panel ancestor, it
  throws (loud: the caller asked for something that doesn't exist).
- **Body layout.** This is internal to the primitive and uses only existing
  primitives:
  - `Stack gap="xs"`.
  - Title: `Inline` of `Text variant="label"` (weight via role, `semibold` if
    the mock needs it) + `Text variant="code" tone="faint"`.
  - Description: `Text variant="caption" tone="muted"`.
  - Chips: wrapped `Inline` of `Badge` (`variant="muted"`, compact). An `off`
    chip is an outlined, faint, `line-through` badge, which needs a new Badge
    `variant` `"absent"` (tokens only), rather than a className at the call
    site.
  - Notice: `Text tone="destructive"` (or a warning tone if one exists).
  - Meta: `Text variant="code" tone="faint"`.
- The hover target sits on a wrapper element (as PickerPill does today), so a
  disabled row still shows its card. That wrapper moves into `WithHoverCard`
  as an option (`wrapDisabled`), or stays in PickerPill. Decide while
  implementing; keep the comment.

### 2. PickerPill adopts it

`PickerPillItemProps.info` changes from `ReactNode` to `HoverCardContent`.
`PickerPillItem` renders `<WithHoverCard card={info} beside="panel">` in place
of `WithTooltip … className="max-w-72"`. Every menu-row card in the app now
looks the same, and a ReactNode body is a type error.

### 3. Workspace migrates

`workspace-info.tsx` becomes a pure mapper,
`workspaceCard(choice): HoverCardContent`:

- title: the profile label or kind label;
- code: `profile.id`;
- description;
- chips: every `WORKSPACE_CAPABILITIES` entry, with `off` when it's missing;
- notice: `unavailable`;
- meta: `[owner, "N MCP tools"]`.

It's renamed to `workspace-card.ts`, and `workspace-pill.tsx:55` is updated to
match.

### 4. The other rich tooltips migrate too (same change)

- `commit-link-chip.tsx`: title = subject, code = short sha, meta = author · time.
- `dependencies-button.tsx` peek: title "Dependencies", and a new card part
  `lists` (headed lists of short lines: "Blocked by" / "Blocking", with
  unresolved ids muted).
- `prototype-thumbnail.tsx`: title = the badge's state, description = the message.
- `WithTooltip` loses its `className` prop: nothing widens a label any more.

## Files

- new `plugins/primitives/plugins/overlay/plugins/hover-card/{package.json,CLAUDE.md,web/index.ts,web/components/with-hover-card.tsx,web/internal/card-body.tsx}`
- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/tooltip.tsx`: add `HoverCardPopup` (Tooltip.Popup rendered as `OverlayPanel`); export from the ui-kit barrel
- `ui-kit/web/components/overlay-panel.tsx`: `data-overlay-panel` attribute
- `ui-kit/web/theme/popover-width.ts` + density token group: `card` role / `popoverWidthCard`
- `plugins/primitives/plugins/css/plugins/badge/{core,web}`: `absent` variant
- `primitives/text-editor/plugins/composer/plugins/picker-pill/web/components/picker-pill.tsx`: `info: HoverCardContent`
- `conversations/plugins/workspace/plugins/launch-option/web/components/workspace-info.tsx` → `workspace-card.ts`, plus `workspace-pill.tsx`

## Verification

1. `./singularity build` (checks, boundaries, docs regen).
2. Screenshot, light and dark: open a task, open the workspace pill, hover a
   scratch-profile row and the worktree row:
   `./singularity run plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts --path <task route> --click "Workspace" --out /tmp/ws`
   (hover via a small e2e flow in the launch-option plugin if `--click` is not
   enough).
3. Compare against the mock:
   `./singularity run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts --name proto-1789901373-oy29 --options placement=icons`.
   Check the card's width, its top aligned to the row, its side, the struck-out
   chips and the mono footer.
4. Hover a disabled (unavailable) row and check the card still shows with its
   notice. Move between rows and check the card switches with no re-delay.
   Open the menu near the right viewport edge and check the card flips to the
   left.
5. `./singularity test plugins/primitives/plugins/text-editor/plugins/composer/plugins/picker-pill`
   (and any existing PickerPill jsdom tests).
