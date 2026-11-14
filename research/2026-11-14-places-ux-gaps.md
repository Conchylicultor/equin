# Places app: usability gaps on desktop and phone (2026-11-14)

Investigation only, no fixes. Plugins: `plugins/apps/plugins/places` (screen in `places-map/web/components/places-screen.tsx`), map primitive `plugins/map` (+ `google`, `pin-layer`).

## Method

- Own build (`./equin build`), driven with the `browser_*` MCP tools at 1280x800 and 390x844, plus `screenshot.ts --viewport 390x844 --touch`.
- Seeded data: 970 places across Paris, real Google Places search worked (the build has a working Maps key; the map falls back to raster because the Map ID is not a vector map — see G11).
- Flows exercised: load, collapse/expand sidebar and list, tap a pin, open a card, search ("Bouillon Racine"), save a Google hit, open its card, open the tag picker, pick a tag.
- Not exercised: real multi-touch pan/pinch (headless emulation only; see "Not verified"), custom pin drop, Ask Sonnet.

Severity: **S1** blocks the flow, **S2** serious friction, **S3** polish.

## Ranked gaps

### G1 (S1, phone) The layout is desktop-only: three fixed-width floating panels stack over a 390 px screen
Repro: open `/places` at 390x844. The tag sidebar (`w-72`, 288 px) and the right side panel (`PANEL_WIDTH` 372 px) both open by default and overlap each other; together they cover the whole map. The panel's "In view 0 / None of the 970 places are in view" empty state is drawn over the half-hidden tag tree.
Desktop: fine (sidebar left, list right, map in the middle).
Cause: `places-screen.tsx` positions everything with fixed widths (`PANEL_WIDTH` 372px, `PLACE_CARD_WIDTH` 340px, `ASK_THREAD_WIDTH` 380px in `card-frame.tsx` / `ask-thread.tsx`) and "reach" constants; no breakpoint, no single-surface-at-a-time rule. The first thing a phone user must do is find the two collapse buttons.

### G2 (S1, phone) The search bar, the main way to add a place, is off-screen
Repro: 390 px viewport. The "Search or add places" input measures x=323, width 320 — it starts 67 px from the right edge and runs off-screen; only a sliver is visible behind the health dot. Pressing `/` focuses it, and the browser then scrolls the whole surface sideways (map half blank, sidebar pill shifted left, cards clipped on the right).
Desktop: fine.
Cause: the floating toolbar (`floatingToolbar`, top-right "Tools" card) has a fixed 320 px search and Filter/Sort/View buttons beside it; nothing collapses to an icon. The global health dot / action bar also floats over the top-right corner.

### G3 (S1, phone) No phone-appropriate way to see the list and the map
The in-view list is a 372 px right panel; on phone it either hides the map or is hidden. No bottom sheet with a peek / half / full detent, no list/map toggle. Google Maps' saved places uses a bottom sheet over the map.
Cause: panel is `asideEnd` of the DataView, not a responsive sheet.

### G4 (S2, phone) Place card is a 340 px floating card covering ~87% of the screen, with no map peek
Repro: tap a pin. The card (hero photo, photo strip, description, status chips, tags, note, footer) fills the screen; the map is a 40 px strip. The selected pin is hidden behind it. Close is a small X on the photo; Back/Esc/click-away is how desktop dismisses (no swipe-down).
Cause: same fixed-width floating card (`PlaceCard`, `card-frame.tsx`); the "click anywhere else closes it" rule needs a visible "anywhere else", which does not exist on a phone.

### G5 (S2, phone) Tag picker opens inline over the card and is clipped
Repro: in a place card tap "+ Tag". The tree (Food, Museum, …) expands in place, overlaps the hero image and the card's header, and once G2's sideways scroll has happened its right edge is clipped. Picking a tag works; the rest of the card is pushed beyond the 844 px viewport with the footer (Open in Google Maps) floating over it.
Desktop: acceptable in a 340 px card but cramped.
Cause: `tag-picker.tsx` is a popover-in-card, not a full-height sheet; no keyboard-aware sizing.

### G6 (S2, phone) Tap targets below 44 px
Measured: map "Fit to the map's places" 24x24, Filter/Sort/View settings 28x28, "Keyboard shortcuts" 14x9, sidebar chevrons and row toggles ~28, app-chrome buttons 32x32. Sidebar tag rows (32 px) pack a checkbox, icon, name, count, add and more buttons.
Cause: desktop density tokens everywhere.

### G7 (S2, phone) Fresh load starts on the whole world with "In view 0"
Repro: load `/places` in a fresh browser at 390x844 (`screenshot.ts --touch`): the map opens zoomed out over Europe/Africa with clusters of 399 and 529, the panel says "None of the 971 places are in view". At 1280 px the same account framed Paris. The initial camera fits to the map area (sized with the covered edges), and with G1's panels covering the viewport the fit area is degenerate or the first fit is lost.
Cause (likely): `use-covered-edges.ts` + the initial fit assume desktop panel layout; worth verifying.

### G8 (S2, both) Pin names are hover-only
On touch there is no hover, so a pin's name (and the list/pin hover link) only appears after selecting it, which opens the full-screen card (G4). Browsing 970 pins by name is impossible at a glance; on desktop the same applies until the pointer is over a pin. A tap on a cluster is the only way to discover places in a dense area.
Cause: `saved-place-pin.tsx` shows the name only while `hovered || active`; touch has a hit-test path in `pin-canvas.tsx` but no "preview" state.

### G9 (S2, both) Chrome overlaps: health dot on the search bar, shortcut hints on touch
The global health dot floats over the search field on every size. The search results show a "⌘⏎" key hint for Ask Sonnet on a phone, and the search field shows a `/` hint — shortcuts that do not exist on touch.

### G10 (S3, desktop) A "Render loop detected" toast fired on first load
`Render loop (cascade): subtree-cascade @ 601/s across 22 nodes — pane:places-map — no React re-render (imperative DOM writes)`, from first load of the full 970-pin set (it appeared once in the main run). Worth a perf look: ~970 invisible accessibility buttons are also mounted over the map (read_page lists one `button` per place), which scales badly with a larger library.

### G11 (S3, both) "Map ID isn't a vector map — fix in setup" banner and raster fallback
A setup warning pill sits at the top centre of the map on this build, and the console shows "Attempted to load a Vector Map, but failed. Falling back to Raster". It is a config issue, not a UX issue, but on a phone the pill competes with the preset pill for the top row.

### G12 (S3, both) Adding a place is a two-step search flow with no map-first option
Searching works well (your places first, then Google hits "around this map area", Save, Drop a custom pin, Ask Sonnet). Gaps against Google Maps: no long-press on the map to drop a pin / add here, no "tap any Google POI on the map to open it" (Google's own places are hidden), no "use my location" button (nothing calls geolocation), saving a hit gives no confirmation beyond the row switching to "Saved". "Want" status is set by default; tagging needs a separate trip into the card.

### G13 (S3, desktop) Tag sidebar and the list duplicate the same filtering
Preset pills (All, Restaurants, Activities), a tag tree with counts and radio chips ("In view 443 / All 970") are all visible together; the tree is long (30 rows) and the sidebar has its own search. Not a blocker; on phone this belongs in a filter sheet.

## Works well (keep)

- Real Google search with ratings, open status, price.
- Saved places appear immediately in "Your places" and on the map.
- Hover-linked list/pin on desktop, rich card with hero photo and facts.
- Clustering and sprite-drawn pins stay smooth with 970 places at desktop size (no visible lag when panning/zooming in emulation; not profiled).

## Not verified

- Real multi-touch pan/pinch/double-tap-zoom: the map uses `gestureHandling="greedy"` (`google-map-impl.tsx`) so Google's own touch handling should apply, but headless emulation cannot show it. `pin-canvas.tsx` notes a tap hit-test for touch.
- Cluster tap behavior, page overlay, Ask Sonnet thread (fixed 380 px docked card, same width issue as G1/G4).
- Custom pin drop (`pin-pick-bar`), and the keyboard covering the search results.

## Suggested direction for the phone prototype

1. One surface at a time on phone: map full-bleed with a top search pill; list as a bottom sheet (peek/half/full); place card as a bottom sheet; tag tree/filter as a full-height sheet.
2. 44 px targets, no hover/keyboard hints on touch, tap shows a name chip before the card.
3. Fix the initial fit with sheets covering the map.
