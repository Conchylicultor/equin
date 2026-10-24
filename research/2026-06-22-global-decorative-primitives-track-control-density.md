# Decorative primitives track ambient control density

## Context

Three "decorative" primitives — `Avatar`, `StatusDot`, `BouncingDots` — each expose
an explicit `size` prop and **never read the ambient control density**
(`useControlSize`). When one sits in a control row (an avatar beside buttons, a
status dot inside a chip, bouncing dots trailing a control), its height/scale does
not track the surrounding density, so it drifts relative to the controls next to it.

This contradicts the house rule the control-size standard already enforces for every
real control (`Button`, `IconButton`, `Badge`, `ToggleChip`, `SegmentedControl`):

> "No control has a `size` prop … density is derived *only* from ambient density
> (`useControlSize`); passing `size` is a compile error on every one of them
> (`size?: never`). There is no per-instance density escape hatch anywhere in the app.
> Size should be set **once by the container**." — `…/control-size/CLAUDE.md`

Deliberate sizes are expressed in this model not by a per-instance prop but by a
deliberately-set **context**: `Bar` declares `sm`, `DataTable` declares `xs`, `Card`
opts in via `controlSize`, or any subtree wraps in `<ControlSizeProvider size>`.

**Goal:** remove the `size` prop from all three primitives (`size?: never`), make each
read `useControlSize()` and map that density to its own visual bundle, and convert
every call site's explicit `size` to either *nothing* (inherit) or a single
container-level density.

## Are the "deliberate size" escape hatches actually legitimate? (No.)

The brief flagged two seemingly-deliberate cases. Examined against the codebase,
**no per-instance escape hatch survives** — every explicit `size=` reduces to one of
three patterns, all better expressed as context:

1. **Redundant with ambient** — the prop just restates the density the container already
   provides. `agent-avatar-row`/`agent-avatar-title-prefix` pass `size="sm"` inside
   header chrome (already `sm`); `avatar-renderer` passes `size="md"` (the default).
   → **Delete the prop**; appearance is unchanged.

2. **A region-density decision wearing an element costume** — the "deliberate" size is a
   property of the *region*, not the element:
   - `ConversationItem` threads `size: "xs" | "sm"` through the **entire `Item.Avatar`
     slot dispatch** purely from its own `layout` (`inline`→`xs`, `block`→`sm`)
     (`conversation-item.tsx:33,115,126`). That is a layout concern; the avatar, its
     pinned status dot, and any future row chips should all snap to one density.
   - `agents-list` passes `size="xs"` to an avatar already inside a `DataView`, whose
     table view wraps content in `xs` via `ControlSizeProvider`
     (`data-table.tsx:42,54`). The prop duplicates the container.
   - The agent-detail **hero** avatar (`size="lg"`, 48 px, sitting next to a name
     `<input>`, no control row) is a genuine visual-hierarchy choice — but it is the
     *header region* that is "comfortable", not the avatar specifically.
   → **The region declares density once** (`<ControlSizeProvider size>` / `DataView`
     `controlSize` / existing `Bar`); avatar + dots + buttons then track together.

3. **An ad-hoc visibility tweak (anti-pattern)** — `AgentStatus` bumps the dot one tier
   *above* its nominal size (`size === "md" ? "lg" : "md"`, `agent-status.tsx:23`) so the
   dot "reads" in a compact list. That is exactly the per-instance divergence we are
   deleting. → **Remove the bump**; the dot tracks the list density. If a tier reads too
   small, recalibrate the *global ramp*, not the call site.

The one case the brief calls "a status dot pinned to an avatar" is **internal to
`Avatar`** (its own `SIZE_MAP` span + ring offsets, `avatar.tsx:31,65-76`), not the
`StatusDot` primitive — it already scales with the avatar's resolved size and needs no
escape hatch.

**Conclusion:** full removal is not merely feasible, it is *more correct* — it converts
hidden per-instance divergence into one explicit, single-source region density. There is
no legitimate per-instance escape hatch; "deliberate" always means "a deliberately-set
context."

## Design

### Mechanism (mirror the `Badge` precedent exactly)

Each primitive imports `useControlSize` (and the `ControlSize` type) from
`@plugins/primitives/plugins/css/plugins/ui-kit/web`, resolves the density internally,
and types `size?: never` with the same comment `Badge` uses
(`badge/web/internal/badge.tsx:40-48`). Deliberate sizing is always a
`<ControlSizeProvider size>` (already exported from ui-kit) around the region.

`ControlSize` has four tiers (`xs | sm | md | lg`); the no-provider default is `md`.

### Per-primitive density → bundle ramps

Preserve each **named tier's** current pixels (so wrapped regions look identical) and
fill the missing tiers. Sites that were *diverging* from their container will snap to
ambient — that is the intended fix, not a regression.

- **`Avatar`** — its existing `SIZE_MAP` is already keyed `xs|sm|md|lg` identical to
  `ControlSize`. Keep the map verbatim (box `size-4/6/8/12`, icon, dot, ring offsets);
  change only the key source: `const size = useControlSize()` instead of the prop
  (`avatar.tsx:39,42`). No visual recalibration.
- **`StatusDot`** — `Record<ControlSize, string>`:
  `xs → size-1` (new), `sm → size-1.5`, `md → size-2`, `lg → size-2.5`
  (sm/md/lg preserved; the current default was `sm`).
- **`BouncingDots`** — `Record<ControlSize, string>`:
  `xs → size-1`, `sm → size-1`, `md → size-1.5`, `lg → size-2`
  (sm/md preserved; the current default was `md`).

### Type cleanup

- Drop the `AvatarSize` type export (`avatar/web/index.ts:3`) — it has **no external
  importers**. Anything that needs to talk about density imports `ControlSize`.

## Call-site migration

`Avatar` (9 explicit sites + default-reliant ones):

| File | Now | Action |
|---|---|---|
| `agents/…/agent-detail.tsx:131` | `lg` (hero) | wrap the avatar in `<ControlSizeProvider size="lg">`; drop prop |
| `agents/…/agents-list.tsx:130` | `xs` | drop; ensure the `DataView` tree provides compact density (set `controlSize="xs"` on the `DataView` if the tree view doesn't already) |
| `agents/…/agent-avatar-row.tsx:31` | `sm` | drop (Item.Avatar slot → inherits row density, below) |
| `agents/…/agent-avatar-title-prefix.tsx:42,88` | `sm` | drop; verify `Conversation.Header` is `sm` (it is a `Bar`/PaneChrome); add `ControlSizeProvider sm` only if not |
| `conversation-category/…/category-avatar-row.tsx:22` | `sm` | drop (Item.Avatar slot) |
| `…/teammate-message/…/teammate-message-row.tsx:53` | `xs` | drop; declare the message row's density once if it isn't already compact |
| `fields/avatar/…/avatar-renderer.tsx:46` | `md` | drop (md == default) |
| `conversation-ui/…/avatar-fallback.tsx:27` | `={size}` | drop prop (see slot change below) |

`Item.Avatar` slot threading (the structural simplification):
- `conversation-item.tsx` — replace the `size: "xs" | "sm"` slot prop with a
  `<ControlSizeProvider>` around each layout branch: `inline` → `xs`, `block` → `sm`
  (lines `33`, `112-126`). Remove `size` from `AvatarSlot`, from
  `Item.Avatar.Dispatch`/the dispatch slot definition, and from every `Item.Avatar`
  contribution signature (`AgentAvatarRow`, `CategoryAvatarRow`, `AvatarFallback`).
  The slot no longer carries a size dimension at all.

`StatusDot` (drop the prop everywhere; convert the one anti-pattern):
- `conversation-view/…/agents/…/agent-status.tsx` — delete the `size` prop **and** the
  `size === "md" ? "lg" : "md"` bump; render `<StatusDot colorClass=… />`; the dot
  inherits the list density. Only caller (`agents-list.tsx:133`) passes no size.
- `build-info.tsx:21,28,35,41` (inside `Badge` icon) → drop; inherit badge density.
- `health-monitor-panel.tsx:269`, `live-state-health.tsx:69,106`,
  `push-gantt.tsx:229`, `scope-tabs.tsx:109`, `pen-button.tsx:37`, `health-dot.tsx:45`,
  `global-action-bar.tsx:55`, `worktree-dropdown.tsx:36`, `server-status-badge.tsx:16`
  → drop; each inherits its surrounding density (Bar=`sm`, debug panes=`md`). Spot-check
  the few that are *not* inside a density-declaring container and wrap once if a visible
  size change is undesirable.

`BouncingDots` (drop the prop everywhere):
- `tool-call-card.tsx:48` (`sm`) → drop; inherits the card density.
- `jsonl-pane.tsx:74`, `pending-turn-echo.tsx:22` already pass nothing — they shift from
  the old `md` default to ambient `md` (unchanged unless a provider is present).

## Files to modify

Primitives (the three + barrels):
- `plugins/primitives/plugins/avatar/web/components/avatar.tsx` (+ `web/index.ts`, `CLAUDE.md`)
- `plugins/primitives/plugins/css/plugins/status-dot/web/internal/status-dot.tsx` (+ `CLAUDE.md`)
- `plugins/primitives/plugins/css/plugins/bouncing-dots/web/internal/bouncing-dots.tsx` (+ `CLAUDE.md`)

Slot simplification:
- `plugins/conversations/plugins/conversation-ui/plugins/item/web/components/conversation-item.tsx`
- the `Item.Avatar` slot definition + contributions: `agent-avatar-row.tsx`,
  `category-avatar-row.tsx`, `avatar-fallback.tsx`

Call sites: the `Avatar` / `StatusDot` / `BouncingDots` files listed in the tables above.

Docs: the three primitive `CLAUDE.md`s gain a "density from context" note mirroring
`badge`; update the `Item.Avatar` slot doc to drop the `size` dimension.

## Verification

1. `./equin build` — `type-check` enforces `size?: never`, so any missed call site
   that still passes `size` is a compile error (the tsc-backed check is the safety net
   for completeness). `eslint`/`no-adhoc-*` must stay green.
2. Scripted Playwright before/after on the highest-signal surfaces, confirming the
   decoration matches the controls beside it and deliberate regions are preserved:
   - Agents list (`http://<wt>.localhost:9000/agents`) — xs avatar + status dot in the
     compact tree align with row controls.
   - Agent detail — hero avatar stays 48 px (lg region).
   - A conversation sidebar row (`block`) and an inline `conv-<id>` chip — avatar + pinned
     status dot scale with layout (sm vs xs), nothing drifts.
   - Build-info badge and the global action-bar dot — dot matches chip/bar density.
   - A running tool-call card — trailing bouncing dots match the card density.
   Use `bun e2e/screenshot.mjs --url … --out /tmp/<name>` per surface.
3. Grep guard: `rg '<(Avatar|StatusDot|BouncingDots)\b[^>]*\bsize='` returns nothing
   outside the primitives' own internals.

## Risks / notes

- **Tier-snap shifts are intended.** A handful of dots/avatars that were diverging from
  their container will change by one step to match it — that is the bug being fixed, not a
  regression. The Playwright pass is to confirm each looks *more* consistent, and to catch
  any dot living in a container with no declared density that jumps to the `md` default;
  wrap such a container once.
- **Ramp calibration is global and reviewable.** If, after the change, the `xs` status dot
  reads too faint in compact lists (the reason `AgentStatus` bumped it), fix it once in the
  `StatusDot` ramp — never reintroduce a per-site size.
- **`DataView` tree density** — confirm the tree view (not just the table view) wraps rows
  in a `ControlSizeProvider`; if it doesn't, that is a small pre-existing gap to close at
  the `DataView` level so `agents-list` inherits cleanly.
