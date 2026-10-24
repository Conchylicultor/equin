# Agent manager sidebar → Mist sizes (proto-1789643584-ldt6), part 2

> **Superseded 2026-09-27.** The component-named type tokens this pass added
> were folded into the type-scale roles; a theme now sets roles, never component
> tokens. See `research/2026-09-27-global-type-scale-role-ladder.md`.

## Context

The first pass (`2026-09-25-global-agent-manager-sidebar-mist-list.md`, commit
24f220c7e) gave the conversation list its structure: single-line rows, quiet group
headers and a row-form view switcher. Measuring the deployed app against the
mockup (page "Agent manager UI", card `block-34f6dc64…`) still showed many
size, weight and colour differences. The user validated every **Sidebar** item
on that page. This pass applies them. The main pane is out of scope.

**Decisions (user, 2026-09-25):**
- **Agent manager only.** The nav rows, model picker, chips and group headers
  are shared with about 11 other apps' sidebars. Every hard-coded size this pass
  touches becomes a **theme token whose default is today's value**. Only the
  Mist theme (`apps/agent-manager/shell/web/internal/theme.ts`) sets the mockup
  value, so other apps render pixel-identically.
- **Sidebar width 246px** (the mockup), not 255.
- **Status dots:** working = filled green, waiting = filled amber,
  starting = hollow muted ring, gone = hollow amber ring, done = hollow faint
  ring. All 7px.
- **Text sizes:** keep the mockup sizes.
- **Selected row brighter:** do it in the shared row primitive, so every
  DataView gets it (user note on "Title colour by state").

**Tolerances accepted, not chased:** 0.5px font differences (model picker 11.5
vs 12, group label 11.5 vs 12) and 1px column offsets. The **activity icon**
(hourglass / upload / flask) still has no data source and stays out of scope.
**Row hover actions** need no change: they overlay the row's right edge only on
hover and take no width at rest, which matches the mockup.

## Design

### 1. New token group `sidebar-metrics` (sizes of sidebar chrome)

`plugins/ui/plugins/tokens/plugins/sidebar-metrics/` mirrors `sidebar-palette`
and `density` (core `group.ts` via `defineTokenGroup`, web registration the
same way `density` registers its group; read `ui/tokens/CLAUDE.md` first).

| Token | Default (today) | Mist |
|---|---|---|
| `sidebarPanelWidth` | `16rem` | `15.375rem` (246px) |
| `sidebarRowHeight` | `2rem` | `1.75rem` (28px) |
| `sidebarRowPadX` | `var(--space-sm)` | `0.5625rem` (9px) |
| `sidebarIconSize` | `1rem` | `0.9375rem` (15px) |
| `sidebarIconGap` | `var(--space-sm)` | `0.6875rem` (11px) |
| `sidebarLabelWeight` | `400` | `500` |

Named `sidebar-panel-width`, not `sidebar-width`, because `SidebarProvider`
already writes `--sidebar-width` inline. It now writes
`"--sidebar-width": "var(--sidebar-panel-width)"` (`SIDEBAR_WIDTH` in
`ui-kit/web/components/ui/sidebar.tsx`); the mobile and icon widths are unchanged.

**Consumers:** `@utility` entries in `ui-kit/web/theme/app.css` (with twmerge
markers; the `app-css-utilities-in-sync` check regenerates the types):
`h-sidebar-row`, `px-sidebar-row`, `size-sidebar-icon`, `gap-sidebar-icon`,
`font-sidebar-label`. `sidebarMenuButtonVariants` (sidebar.tsx) swaps `h-8`,
`p-sm` (x part), `gap-sm`, `[&_svg]:size-4` for these, and adds
`font-sidebar-label`. `SidebarNavItem` (`app-shell/web/components/sidebar-nav-item.tsx`)
swaps its `size-4` icon for `size-sidebar-icon`. With the defaults, every other
app computes to exactly today's pixels.

### 2. Sidebar colours: two palette values in Mist, one new slot

- New `sidebar-palette` slot `sidebarIcon` (default `currentColor` = today).
  The menu button paints `[&_svg]:text-sidebar-icon`, and uses the current colour
  when hovered or active. Mist: `mutedText` (0.66), so nav icons at rest are muted
  and the active one is 0.80, as in the mockup.
- Mist `sidebarAccentForeground` → bright 0.95 (new `DARK.textStrong`; light-mode
  equivalent). This is the sidebar's emphasised text: the active nav item and the
  brand name (next section) use it.
- Mist `accentForeground` → the same 0.95, for the selected row (§5).

### 3. Header (agent-manager-owned code)

- **Brand** (`apps/agent-manager/shell/web/components/agent-manager-layout.tsx`):
  14.5px / 700 / tight tracking, in `text-sidebar-accent-foreground`. Use
  `Text variant="subheading"` with a Mist `type-scale` override
  (`fontSizeSubheading: 0.9063rem`) plus `font-bold`, **only if** `rg` shows no
  other agent-manager surface uses `subheading`. Otherwise use `variant="label"`
  (13px) + `font-bold` and accept the 1.5px difference.
- **Model picker** (`conversations-view/web/components/launch-sidebar-item.tsx`):
  gets 28px height and 9px padding from §1 for free. Add
  `text-sidebar-accent-foreground`. Its dot follows the 7px dot (§4).
- **Run button:** `h-sidebar-row` so it matches the picker (32×28).

### 4. Status dots

- **7px:** new density tokens `statusDotXs/Sm/Md/Lg` (defaults `0.25 / 0.375 /
  0.5 / 0.625rem`, today's `size-1…2.5`). `StatusDot` reads them through
  utilities instead of the literal classes. Mist sets `statusDotMd: 0.4375rem`.
  The conversation line row renders its dot at `md` (a `ControlSizeProvider` on
  the lead box), like the picker's dot.
- **Hollow rings:** `StatusDot` props become a discriminated union:
  `{ colorClass }` (filled, today) | `{ ringClass }` (1px border, transparent
  fill). `CONV_STATUS_DOT` (`conversation-ui/item/web/components/conversation-item.tsx`)
  maps each status to one of the two, following the decided mapping. This is
  the conversation-status vocabulary, so it applies wherever the dot appears,
  not only in the agent manager.

### 5. Conversation row (`layout="line"`, sidebar-only)

- **Title:** `text-caption font-medium` at full size (12px / 500), not the
  11px compact rung. Row pitch stays 28px.
- **Lead column** aligned with the nav icons: lead box `size-sidebar-icon`, gap
  `gap-sidebar-icon`, so the dot centres under the nav icons and titles start on
  the nav labels' column (±1px, because `Row` pads 8px where nav rows pad 9px).
- **Time:** `text-faint-foreground` (short format only).
- **Selected row brighter:** `Row` (`css/row/web/internal/row.tsx`) adds
  `text-accent-foreground` to its selected chrome, next to `bg-accent`. Every
  DataView gets it. Themes where accent-foreground equals foreground see no
  change; Mist gets 0.95.
- Muted idle rows are already handled: `rowTone` mutes `gone` and `done`.

### 6. Count chip (Badge compact rung)

The mockup's chip is 17×17, padding 0 4px, radius 6px, 9.5px / 600. Header chips
elsewhere in Mist are larger, so only the **compact (xs) rung** changes:

- density: `padChipCompactX`, `padChipCompactY`, `radiusChipCompact`
  (defaults = `padChipX`, `padChipY`, today's `rounded-md` value);
- type-scale: `fontSizeChipCompact`, `lineHeightChipCompact`,
  `fontWeightChipCompact` (defaults = `font-size-2xs`, `line-height-2xs`, 500).

`Badge` (`css/badge/web/internal/badge.tsx`) uses these when its density is `xs`.
Mist sets 4px / 1px / 6px and 0.594rem / 0.9375rem / 600.

### 7. Group header and view switcher (both opt-in and used only by this sidebar)

- **Quiet group header** (`data-view/web/internal/grouped-sections.tsx` quiet
  branch): label `font-semibold`; count `tone="faint"` + `font-semibold`, one
  `gap-sm` after the label. **Indent:** the label currently sits 8px from the
  sidebar edge, because `rail-follow` resolves to 0 there and only `p-row` applies.
  The mockup puts it at 17px, on the nav icon column. Find why the rail does not
  apply inside the DataView and fix it at that level, rather than adding padding.
  (The page item "Label indent" wrongly says 54px, which is the count's position.
  Correct it.)
- **Switcher row** (`view-core/.../collapsed-view-switcher.tsx` `appearance="row"`):
  label `font-medium`, icon and label on the nav columns (as in §5). In
  `sidebar-frame.tsx`, drop the frame's `py-2xs` so the line is one 28px row
  (36px today).

### 8. Active nav item

Nav entries are `{title, icon, onClick}`, so the shell cannot know which one is
current, and nothing is ever highlighted. Make it derivable instead of adding a
flag. `AppShellSidebarNav` gains an alternative arm `{ opens: { pane, params } }`
(xor `onClick`). The shell opens it with `openPane(pane, params, {mode:"root"})`
and marks the row `isActive` when the current route's root slot is that pane
(`useRoute()` in `primitives/pane`). Migrate the agent manager's five entries (Tasks,
Agents, Conversation, Explorer, Stats), which already call `openPane(X, …, {mode:"root"})`.
Other apps keep `onClick`, and nothing changes for them. Check which root the
`/agents/c/:id` conversation route resolves under, and report it. The mockup
highlights "Agents" there.

## Files (representative)

- new `plugins/ui/plugins/tokens/plugins/sidebar-metrics/{core,web}` + CLAUDE.md
- `plugins/ui/plugins/tokens/plugins/{density,type-scale,sidebar-palette}/core/group.ts`
- `plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/sidebar.tsx`, `web/theme/app.css`
- `plugins/primitives/plugins/app-shell/web/components/{sidebar-nav-item,app-shell-layout}.tsx`
- `plugins/primitives/plugins/css/plugins/{status-dot,badge,row}/web/internal/*`
- `plugins/primitives/plugins/data-view/web/internal/grouped-sections.tsx`,
  `data-view/plugins/view-core/web/components/collapsed-view-switcher.tsx`
- `plugins/conversations/plugins/conversation-ui/plugins/item/web/components/conversation-item.tsx`
- `plugins/conversations/plugins/conversations-view/web/components/launch-sidebar-item.tsx`,
  `conversations-view/plugins/data-view/web/components/sidebar-frame.tsx`
- `plugins/apps/plugins/agent-manager/plugins/shell/web/{internal/theme.ts,components/agent-manager-layout.tsx}`
- the five nav contributors (`tasks/task-detail`, `conversations/agents`,
  `conversations/all-conversations`, `code-explorer`, `stats` web barrels)
- CLAUDE.md prose for each touched primitive; `docs/` regenerate on build

## Verification

- `./equin test` on `css/status-dot`, `css/badge`, `css/row`,
  `app-shell`, `data-view`, `conversation-ui/item`. New cases: `StatusDot`
  ring arm; `SidebarNavItem` active from the route; `Row` selected class.
- `./equin build` (background, then report the deploy).
- Re-run the computed-style dump on the deploy's sidebar and compare each
  validated sidebar item against the mockup numbers. Record the before/after
  measurements in the page card.
- **No-regression:** screenshots of Pages, Mail and Settings sidebars must be
  pixel-identical to main (every default equals today's value).
