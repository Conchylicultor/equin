# Settings card: a third control-panel surface, and Sonata settings to its mock

## Context

The Sonata settings gear (`MidiFoldersSettingsButton`,
`plugins/apps/plugins/sonata/plugins/sources/plugins/midi/plugins/folders/web/internal/folders-settings.tsx`)
does not match its approved mock, proto-1792907625-p861lr (`?case=several&sheet=open`):
it has no title or ×, its section heading is the faint menu label, it is 280px wide instead of
about 440, paths are absolute and cut off, the trash icon is bright, focus rings the first trash
button on open, the add field is a solid input with an icon-only browse button, and the spacing is tight.
The library notice (`folder-notice.tsx`, `placement=strip`) centres its icon tile where the mock
puts it at the top, and its type sizes differ.

**Why it happened.** The agent reached for `ControlPanelPopover`, the only surface for "a
popover of settings". That vocabulary is built for a *menu of choices*, so the card got its
look: a menu label, the `described` wrap width, caption prose and no title. Nothing was wrong
with each call. The surface simply had no form for *a titled card of settings sections*.

**The fix in the abstraction.** Making the primitive *flexible* (a `headingStyle` prop, a
`width` prop) is wrong. That reopens the escapes the vocabulary deliberately removed, and the
next agent will still pick the wrong values. Instead, add the missing **role**:
`ControlPanelCard`, the third surface next to `ControlPanelPopover` (menu) and `ControlPanelPane`
(pane). The vocabulary already has the mechanism for this: the **host policy**
(`useControlPanelHost()`, `web/internal/host.tsx`), where the *surface*, not the call site,
decides how members present. The same `<ControlPanel.Section label description>` then renders
as a menu label in a popover and as a heading in a card. An agent picks a surface by what the
thing *is*, and the look follows. There is no styling choice left to get wrong (rung 1 of the
ladder).

## Part A: primitives

### A1. `ControlPanelCard`, in `primitives/css/control-panel`
New `web/internal/control-panel-card.tsx`, exported from the barrel.

- Props: `trigger | anchor` (the same `Anchoring` union as the popover; share the type),
  `title: string` (**required**: a card is a titled thing; it also names the panel for
  assistive tech, so there is no separate `label`), `align`, `side`, `open` / `onOpenChange`,
  `children`. Like its siblings it has **no** `width`, `padding` or `className`.
- It renders `Popover` + `PopoverContent` with the existing **`header`** prop (sticky,
  full-bleed): the title in a heading rung and an `IconButton` ×, which closes the card
  (controlled internally if the caller passes no `open`).
- **Width**: a new density token `popoverWidthSettings` (`popoverWidthCard` is the hover card's) (default `27.5rem`, the value the prototypes theme already uses for
  its wide described panels), with a `settings` role in `POPOVER_WIDTH`
  (`ui-kit/web/theme/popover-width.ts`) and an entry in `ui/tokens/density/core/group.ts`. The
  card is fixed at it, like a dialog's size. That fits invariant #5: the *surface* is the role,
  so no call site names a width. A `RuleRow` / `picker` need inside a card is out of scope.
  Document that a card is not a `cp-surface`, so the overflow guard does not apply. Or make
  the guard apply to it: decide during implementation, preferring the guard.
- **Initial focus**: the popup itself (base-ui `initialFocus` on a `tabIndex={-1}` header),
  never the first tabbable. A card opened by pointer must not ring a row action. Tab then
  enters the first control.
- Host policy published: `{ nesting: "inline", inlineDepth: 1, descriptions: "band",
  sections: "heading" }`.

### A2. Host policy gains `sections: "label" | "heading"`
`host.tsx`: a new required field. Popover and pane publish `"label"` (unchanged look), the card
publishes `"heading"`. `ControlPanelSection` (`control-panel.tsx:159`) reads it:

- `label`: what it does today (`MENU_LABEL_PAINT` caption, muted caption description).
- `heading`: a foreground semibold body-rung heading, with a leading icon allowed (the
  existing `label` node stays a ReactNode). The description is the body-size muted prose
  (`variant="label"` in Sonata's scale, about 12–12.5px), with the gap and bottom space the mock
  shows (`h3` margin 2px, hint 12px). Band padding follows the card's larger inset (mock: 18px
  side, 6/18 vertical) through the panel's own rail variables, not per-call padding.

Update the control-panel `CLAUDE.md` ("two surfaces" → three, plus the host table and the
label-rungs section), and add a card exhibit to `exhibits/` so `layout-geometry` sweeps it.

### A3. `FolderPickerPopover` gains an *add* form
`primitives/folder-picker/web/internal/folder-picker-popover.tsx`: add a required
`purpose: "edit" | "add"` (two call sites: `fields/directory-path/.../dir-path-renderer.tsx`
→ `edit`, Sonata → `add`).
- `edit`: today's form (solid input, validity mark, icon-only browse).
- `add`: a dashed full-width field (the mock's `border-dashed`, solid on focus) and a labelled
  `Browse…` button (`Button variant="secondary" shape="pill"`). It commits on Enter or blur and
  clears itself, absorbing Sonata's `addKey` remount hack.

The input's dashed look: prefer a `dashed` arm on `Input` mirroring `Button variant="dashed"`
(ui-kit's field paint). If `input.tsx` is shadcn-owned and cannot take it cleanly, put the class
in the folder picker with a comment.

### A4. Home-relative paths, next to `hostHome`
`hostHome` lives in **`infra/host-account/core`** (not host-fs as I said in the question; same
intent). Move `HOME`, `absolutePath` and `displayPath` (with their tests) from
`apps/file-explorer/plugins/browser/core/internal/paths.ts` to `infra/host-account/core`, and
point file-explorer's importers at them (no re-export, per the boundary rules). The other
helpers in `paths.ts` (`joinPath`, `parentPath`, …) stay where they are.

## Part B: Sonata

### B1. Settings card (`folders-settings.tsx`)
- `ControlPanelPopover` → `ControlPanelCard title="Sonata settings"`. The section keeps
  `label={<icon/> MIDI folders}` and `description`, with no `needs`.
- `FolderRow`: the path through `displayPath(path, home)` (`useLive(hostHome)`; until home is
  known, the absolute path, which is true rather than a stand-in), at the mock's 12px/500 mono
  (a step above `Text variant="code"`). Measure first, and add a rung only if `code` cannot
  reach it. Trash `IconButton` muted at rest (`text-muted-foreground`, full on hover). Row
  padding and gap to the mock: 9/8/9/10px, gap 10px, 6px between rows, 30px icon tile, radius
  about 13px.
- Add field: `FolderPickerPopover purpose="add"`. Drop `addKey`.

### B2. Notice (`folder-notice.tsx`)
- Icon tile pinned to the top of the row while the actions stay centred (mock: `align-self:
  start` on the tile only). The layout lint forbids `self-*`, so wrap the tile in the column
  primitive that expresses it, or put the row on `align="start"` and centre the action
  cluster. Choose whichever matches in the diff.
- Type: title 13.5px semibold (body rung + semibold), path chip 11px mono (`FolderPath`, also
  `~/`-shortened through A4), body 12.5px (`variant="label"`, not `caption`), status 11.5px faint.
  Row padding 14/16px, gap 14px.

## Verification

1. `./equin build` (background), then compare:
   ```bash
   ./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts \
     --name proto-1792907625-p861lr --options case=several,sheet=open --out /tmp/cmp-sheet
   ./equin run plugins/apps/plugins/prototypes/plugins/compare/e2e/compare-diff.ts \
     --name proto-1792907625-p861lr --options case=several,placement=strip --out /tmp/cmp-strip
   ```
   Run both **before** any change for a baseline ratio, then iterate on the heatmap until the
   card and notice cells are close. The real app has to be put in the same state (two
   unreadable folders and one healthy one, card open), so check how compare-diff drives that.
   If it cannot, extend its options or seed the worktree config, and say which.
2. `browser_*`: open the gear and check that the title and × show, × closes, focus is not ringed
   on open, Tab reaches the first row, `~/` paths show, and Browse… opens the picker.
3. `./equin check` (layout-geometry picks up the card exhibit; `plugins-doc-in-sync`) and
   `./equin test plugins/primitives/plugins/css/plugins/control-panel
   plugins/primitives/plugins/folder-picker plugins/infra/plugins/host-account
   plugins/apps/plugins/file-explorer`.
4. Regression: a `ControlPanelPopover` (Tasks toolbar view settings) and Settings → Config
   (pane) look unchanged, because both publish `sections: "label"`.

## Follow-ups (not in this change)
- Audit other `ControlPanelPopover` call sites that are really titled settings cards and move
  them to `ControlPanelCard`.
- Prototype authoring: name the surface role a mock's popover plays (menu / card / pane), so
  that implementing it is a lookup rather than a guess.

## As built (deviations from the plan above)

- **Type picks are read by CSS var.** control-panel cannot import the overlay
  token group (theme-engine → config_v2 → … → control-panel is a cycle), so the
  three `RolePart`s live in `control-panel/web/internal/settings-picks.ts`,
  naming the overlay group's `settingsTitle*` / `settingsHeading*` /
  `settingsProse*` tokens by var, as any component reads a token.
- **The title row is not the popover's `header` prop**: that wrapper draws a
  rule and a menu inset. It is the card's first child, on the rail, padded by
  `cp-card`'s `[data-cp-card-head]` rule.
- **No card exhibit yet**: a card only exists inside an open popover, which a
  region exhibit cannot host. Follow-up.
- **`Input outline="dashed"`** (ui-kit) is the add field's hairline.
- **Measured** with `browser_*` part by part (compare-diff photographs whole
  frames and cannot open the card): width 440 = 440; title 15/700 vs 14.5/700;
  heading 13.5/700 = mock; prose 12px/17 vs 12px/17.4; paths `~/…` 12px/500
  mono = mock; rows within 1–3px vertically; trash and × muted; focus on the
  title row when opened by pointer. Notice: title 13.5/600, body 12.5/400, tile
  top-aligned, as the mock.
