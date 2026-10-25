# Browser app — Chrome-style restyle (from proto-1792901196-2xyrv7)

## Context

The Browser app (`plugins/apps/plugins/browser`) looks like a generic toolbar:
row-chip tabs in a pane bar, a square search field, a proxy shield floating in
the trailing actions, card tiles and an instruction footer on the start page.
Prototype `proto-1792901196-2xyrv7` (layout `stacked`) designed what it
should look like; the user asked to make the real app match it pixel for pixel,
autonomously, and push.

## Target (the prototype's `stacked` layout)

1. **Tab row** (top): the app launcher (`AppShellBrand form="icon"`), then
   Chrome-shaped tabs: 34px box with a 3/4px transparent inset, so a hovered tab
   paints a fully rounded pill inside the box and never moves. The active tab
   paints its whole box (rounded top, square bottom) in the content colour,
   with 12px S-curve flares into the toolbar. Hairline separators between
   inactive tabs, hidden next to the active or hovered tab. Then `+`. The row
   wears the recessed `chrome` surface. It is the floating action bar's band
   (`pr-floating-bar anchor-floating-bar-band`).
2. **Toolbar**: back · forward · reload, then the pill omnibox, then open
   external. Home is dropped (a new tab is the start page). The pill holds:
   - a leading **site-info** button (lock; shield while the proxy is on). It
     opens a popover with the host and the contributed site-info rows. The
     proxy switch moves there from the trailing actions.
   - the address: when unfocused it shows the host in the foreground colour
     and the path faint; when focused it is the editable input.
   - trailing **in-field actions**. The bookmark star moves here, hidden on
     the start page.
3. **Bookmarks bar**: favicon and name chips, no line between it and the
   toolbar. One hairline under the whole chrome block.
4. **Loading bar**: 2px primary bar easing to about 80% while loading.
5. **Start page**: a time-of-day greeting ("Good morning."), a large pill
   search field, a grid of pins (44px rounded tile with favicon and name;
   quick links followed by bookmarks), and "Recently visited" rows (favicon,
   title, host, short relative time). The instruction footer is removed.

## Design

- **New shell slots** (`shell/web/slots.ts`), each a render slot of `{ component }`:
  - `Browser.OmniboxAction`: trailing in-field controls of the address pill.
  - `Browser.SiteInfo`: rows of the site-info popover.

  Moving the star and the proxy switch is then a contribution change in their
  own plugins. The omnibox stays the slot host and never names them.
- **Tab geometry** lives in a plugin-local `tabs/web/components/tab-strip.css`.
  Pseudo-element flares and separators have no Tailwind or primitive spelling.
  This is the same precedent as `page-header.css` and `chord-box.css`. Colours
  come only from tokens (`--background`, `--sidebar`, `--border`, `--foreground`).
  Tabs reuse `TabCloseButton` and `hoverRevealGroup`, plus `Favicon`, `Text`
  and `Line`.
- **Omnibox** (`omnibox/web/components/omnibox.tsx` plus `omnibox.css`) is a
  bare `<input>` in a pill, with a decorative formatted-URL layer shown while
  unfocused. The site-info trigger is `InlinePopover` with an `IconButton`.
- **Layout** (`shell/web/components/browser-layout.tsx`): the tab row is above
  the toolbar `Bar` (`endSafeArea={false}`). The toolbar and sub-bar are
  wrapped in one bordered block.
- **Proxy** contributes `Browser.SiteInfo` (a `Switch` row) instead of
  `Browser.Actions`.
- **Start page** components are restyled in place (`hero.tsx`,
  `link-tile.tsx`, `quick-links.tsx`/`bookmarks-section.tsx` merged into one
  pins grid, `recents-section.tsx`, `start-page.tsx`).

Out of scope, to be follow-ups: omnibox suggestions dropdown, a ⌘L shortcut,
the prototype's "won't open inside equin" page (framing refusal is not
detectable from a cross-origin iframe), and a ⋯ menu.

## Verification

- `./equin build` (checks: lint for layout/typography/radius/z rules,
  type-check, plugin docs).
- `./equin test plugins/apps/plugins/browser` (bookmark-star/bookmarks-bar
  tests move with the star).
- Screenshot `/browser` on the worktree build in light and dark. Hover a tab
  and confirm the boxes stay put. Open site info, toggle the proxy, star a
  page. Compare against the prototype with `compare-diff.ts`.
