# Agent manager main pane → Mist (proto-1789643584-ldt6)

> **Superseded 2026-09-27.** The component-named type tokens this pass added
> were folded into the type-scale roles; a theme now sets roles, never component
> tokens. See `research/2026-09-27-global-type-scale-role-ladder.md`.

## Context

The sidebar was aligned with the Mist mockup in two passes
(`2026-09-25-global-agent-manager-sidebar-mist-{list,metrics}.md`). The main
conversation pane (title bar, toolbar, thread, tool rows, prompt, footer) still
looks and feels heavier than the mockup. Every measured difference, and the user's
decision on each one, is recorded on the "Validated:" lines of page "Agent manager UI",
card `block-34f6dc64-ae65-4dd0-96d7-5b197ec280d1` (recorded 2026-09-26).

**Rule (unchanged from the previous pass): agent manager only.** Every shared size
or colour this pass touches becomes a **theme token whose default is today's
value**. Only Mist (`plugins/apps/plugins/agent-manager/plugins/shell/web/internal/theme.ts`)
sets the mockup value. Mist tokens apply only under
`[data-theme-scope="app:agent-manager"]`, so other apps stay pixel-identical.

**Decisions**
- Title bar, toolbar, prompt box, placeholder, split launch buttons, primary
  button, right-side icon buttons, footer pills, base font, text brightness,
  corner radius: match the mockup.
- Main-pane text sizes: keep the mockup's sizes (decided 2026-09-25).
- Messages:
  - Message prose uses a **single colour** (the app's 0.82, unchanged).
  - Assistant text gets **no card**.
  - The user card takes the mockup's chrome; its "Show more" clamp and sticky
    header stay.
  - Cards in the thread use a 12px radius.
  - Inline code chips match the mockup.
- Tool calls:
  - The card matches the mockup.
  - The badge takes the mockup's **shape**, keeping its teal colour.
  - The description stays **muted**.
- **Chevron removed from every collapsible transcript card**, in every theme (the
  user asked for "everywhere"). The whole row is still the toggle.
- No behaviour changes:
  - The per-message timestamp and actions stay (they are already revealed on hover).
  - The button row keeps its placement.
- Context line: the app keeps its sticky chips; **the mockup is updated** to
  show them.
- Model dot in the footer: ignored.
- Sidebar op-status icon: 11px, muted.

## Design

### 1. Type scale (Mist only)

- `type-scale`:
  - Mist `fontSizeBody` goes to 0.78rem (12.5px) and `lineHeightBody` to
    1.09rem (17.5px).
  - This covers user and assistant prose (`<Text variant="body">`) and the
    prompt field and placeholder (`text-body` in `text-editor-impl.tsx`).
  - The placeholder lands on 12.5px against the mockup's 12px, which is within
    the 0.5px tolerance already accepted in the previous pass.
- **Base font:**
  - New tokens `fontSizeBase` and `lineHeightBase` (defaults `1rem` and
    `1.5rem`, today's inherited values).
  - They are applied in the `:root, [data-theme-scope]` inheritance block of
    `ui-kit/web/theme/app.css`, next to `font-family` and `color`.
  - Mist sets them to `0.75rem` and `1.4`.
  - They are **never** set on `html`, which would rescale every rem token.
- Control text (`fontSizeControl` / `fontWeightControl`): Mist sets 11px / 600.
  This covers the toolbar counters, launch buttons and footer pills. The
  toolbar counters are measured again first (Artifacts button, b46fd4a41).

### 2. Colour (Mist only)

- `foreground` is **unchanged** at 0.82 (user, 2026-09-26: 0.95 is too bright
  for prose; the mockup's own prose is mostly 0.80). Message prose stays one
  colour.
- Only the conversation title in the title bar goes to the strong step (0.95,
  `DARK.textStrong`), the one item validated for it.
- The existing scale already gives the other steps: 0.80 secondary, muted 0.66,
  faint 0.52. Surfaces that the mockup draws at 0.80 move onto the secondary
  step: the header chips, the launch buttons, and the footer's "Branch" pill
  (muted today). Toolbar icons go muted.

### 3. Controls: tune Mist's control ladder, and put each surface on a rung

The `density` rungs `controlHeight/Pad/Gap{Xs,Sm,Md,Lg}` already exist. Mist
retunes the rungs, and each surface **picks a rung** through `ControlSizeProvider`
instead of hand-set sizes. The mockup targets are:

| Surface | Mockup | Rung |
|---|---|---|
| Toolbar buttons | 26px, padding 4/7, icon 13px | sm |
| Split launch group | 27px, main padding 5/10, 26px arrow | sm |
| Footer pills | 25px, padding 5/10, icons 11–12px | xs |
| Primary (Stop/Restore) | 29px, padding 7/14, 12px / 700 | md |
| Prompt icon buttons | 12px muted icons | xs, icon only |

The exact values per rung are set from this table during implementation:
- Differences of 1px are tolerated.
- A surface whose target no rung can express gets its own token.
- It never gets an ad-hoc class.

**Control icon size:**
- New `density` tokens `controlIconXs..Lg`, defaulting to today's `size-3` and
  `size-4`.
- `button.tsx` reads them in place of the literal `[&_svg]:size-*`.
- Mist sets 12–13px.
- `IconButton` inherits them, so every toolbar and prompt icon follows.

### 4. Radius

- **New `shape` token `radiusCard`:**
  - Default `calc(var(--radius) * 0.8)`, today's `rounded-md`.
  - `SURFACE_LEVELS.raised` (`ui-kit/web/theme/surface.ts`) reads it through a
    `rounded-card` utility.
  - Mist sets `0.75rem`, which gives 12px on every card: user message, tool
    row, meta rows, prompt box.
- **Controls:**
  - Mist's `radius` of 0.7rem already gives 9px at `rounded-md`, which xs and
    sm buttons use.
  - md buttons use `rounded-lg`, 11px. A `radiusControl` token (default
    `var(--radius)`) replaces that `rounded-lg` in the button base, and Mist
    sets 9px.
- Pills stay at 999px.
- The prompt box moves from `rounded-md` to the card radius.

### 5. Surfaces (conversation-view owned)

- **Title bar** (`PaneChrome` → `Bar tier="pane"`):
  - Mist `chromePaneH` becomes 45px.
  - The mockup's 16px right padding and 8px left padding: take the closest
    `chromePadX` if the asymmetry comes from the title's leading button, and
    confirm this by measuring.
  - Header chips (`model-badge.tsx`, `status-badge.tsx`): Mist chip padding of
    4/11 at the badge's sm rung, 11px / 600 at 0.80.
  - The model chip's background becomes a new palette slot `chip` (default
    `muted`, today's badge fill). Mist sets `panel` 0.225.
  - The status chip keeps its per-status colours.
- **Toolbar** (`conversation-view.tsx:76-81`, a hand-rolled strip):
  - It becomes `<Bar>` with a new `tier="subpane"`, or it reuses the pane
    tier's padding tokens, whichever `bar.tsx` supports more cleanly.
  - Mist sets 35px tall and 4px 14px padding.
  - Buttons get the sm rung (§3).
- **User message card** (`user-text-row.tsx:80`):
  - Today's `rounded-md border border-border/60 bg-background px-md py-sm`
    becomes `Card`-level chrome: card radius, faint border, a new `threadCard`
    palette fill (default `background`, Mist `panel`), and card padding.
  - Mist `padCard` is 10px 14px. If `padCard` is used elsewhere in the agent
    manager at a different target, it gets its own `padThreadCard` token.
- **Inline code** (`markdown/web/internal/inline-code.tsx`):
  - Mist: 11.5px mono, padding 1.5px 6px, radius 7px, a 0.265 fill, and a 1px
    border.
  - The **per-kind border tint** (paths blue, keywords teal, removed red) needs
    a kind the markdown renderer does not know about today. Measure the app's
    code chips first. If kinds are not already derivable, implement the neutral
    border only and report it.
- **Tool row card** (`collapsible-card.tsx`):
  - `CARD_CHROME` moves to tokens: a `threadCard` fill (default `muted/20`, Mist
    0.225), a faint border, and card padding 10px 13px.
  - The row reaches the mockup's 47px through padding plus the row's line
    height.
  - **Remove `<CollapsibleChevron>`** from the identity group, in every theme.
    The `aria-label` Expand/Collapse on the overlay button already carries the
    state.
  - Meta rows (Thinking / Skills / hooks) share this card, so they follow
    automatically.
- **Tool badge** (`tool-call-card.tsx:69-81`):
  - Mist shape: 10.5px / 700 mono, padding 3px 9px, radius 8px, and a 1px
    border in the current colour at about 28%.
  - Colour stays `primary` (teal) or `destructive`.
  - The shape comes through tool-badge tokens (padding, radius, weight, border
    width 0 by default), not through the compact-chip rung, which the sidebar
    count chip already uses.
- **Tool description**: no change (it stays muted).
- **Prompt box** (`text-editor-impl.tsx` `EditorShell`):
  - Mist: 10px 13px 9px padding, a `panel` 0.225 fill instead of `input/30`,
    and the card radius.
  - These come from new text-editor tokens (`padComposer`, a `composer` palette
    slot defaulting to today's `input/30`).
  - The mockup's 92px height follows from the padding and the rungs; it is
    verified, not set.
- **Split launch group** (`launch/web/components/launch-control.tsx`):
  - The `ButtonGroup` gains an outline: a 1px faint border and a divider before
    the arrow segment.
  - This goes through a `buttonGroupOutline` token, default `transparent` (today
    it has no outline), and Mist sets it to faint `border`.
  - Segment fill: Mist 0.265. Arrow segment: 26px wide.
- **Primary button** (`push-and-exit-button.tsx`): md rung (§3), weight 700
  through the button's own weight, and colours stay per state.
- **Footer** (`conversation-view.tsx:96-109`, `branch-buttons.tsx`): the row gets
  the xs rung, and "Branch" moves from `text-muted-foreground` to the secondary
  step in Mist. That goes through a token or a tone change whose default stays
  muted.

### 6. Sidebar op-status icon

`op-status-chip.tsx:60` today uses `size-3.5`. It takes a `density` token
`opStatusIcon` (default 0.875rem), and Mist sets 0.6875rem (11px). The colour is
already muted.

### 7. Mockup update (context line)

The prototype (`~/.singularity/apps/prototypes/proto-1789643584-ldt6/`; read
`prototypes/CLAUDE.md` first) replaces its plain-text context line with the app's
sticky chips (`StatBadge`, 20px, padding 2px 6px, pinned at the transcript's
foot). This touches only that prototype's folder.

## Files (representative)

- `plugins/ui/plugins/tokens/plugins/{type-scale,density,shape,color-palette}/core/group.ts`
  (the new tokens, each defaulting to today's value)
- `plugins/primitives/plugins/css/plugins/ui-kit/web/theme/{app.css,surface.ts}`,
  `ui-kit/web/components/ui/{button,button-group}.tsx`, the generated utility types
- `plugins/primitives/plugins/text-editor/web/components/text-editor-impl.tsx`
- `plugins/primitives/plugins/markdown/web/internal/inline-code.tsx`
- `plugins/primitives/plugins/launch/web/components/launch-control.tsx`
- `plugins/primitives/plugins/bar/web/internal/bar.tsx`
- conversation-view:
  - `web/components/conversation-view.tsx`
  - `plugins/{header,model,status,branch,push-and-exit,op-status}/web/components/*`
  - `plugins/jsonl-viewer/plugins/{collapsible-card,tool-call,user-text}/web/components/*`
- `plugins/apps/plugins/agent-manager/plugins/shell/web/internal/theme.ts`
- The CLAUDE.md prose of each touched primitive; `docs/` is regenerated on build.

## Verification

- Before implementing, measure these in the deployed app:
  - the toolbar counters (stale)
  - inline code (never compared)
  - the Working-state header chip and the Stop button
- `./equin test` on `css/badge`, `ui-kit`, `text-editor`, `launch`,
  `collapsible-card`, `user-text`. New case: CollapsibleCard renders no chevron,
  and the row still toggles.
- `./equin build` (in the background), then report the deploy.
- Run the computed-style dump again on a conversation in the deploy (a Working
  one and a Done one), and compare each validated item against the mockup
  numbers. Record the before and after values in the page card.
- `compare-diff.ts --name proto-1789643584-ldt6` for an overall diff.
- **No regression:** screenshots of Pages, Mail and Settings (panes, buttons,
  cards, the text editor) must be pixel-identical to main, apart from the
  chevron removal in transcript cards.
