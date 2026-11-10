# The demo: a gate on every visit, an expanded website band, and a maximize with Esc, animation and notice

Task: user feedback after trying the website's live demo (track page
"Track: apps running in the browser, on fake or local data"). Builds on
`research/2026-11-10-global-website-composition-carries-live-demo.md`.

## What changed

1. **No "demo was updated" notice.** `HostBooted.notice` is gone from the
   browser-server port protocol (`browser-server/core/internal/port.ts`), so
   DemoScope has nothing to draw. A build with a new snapshot replaces the
   visitor's data silently (`whenOutdated: "reset"` is unchanged).
2. **The gate on every visit.** `DemoScope` splits "the visitor entered" from
   "the host may start". With `boot`, the gate always shows. Behind it the host
   starts at once where `hostDataStored` says the browser holds the data, so
   Enter is instant. A first visit still downloads nothing before Enter.
   `DemoBoot` lost its `asking` arm.
3. **The website band expands on Enter and stays expanded.** It used to start
   by itself on a return visit, so Enter (which grows the frame) never ran.
   Collapse / Expand is removed.
4. **The website band's place is the homepage's URL.** The embed's location and
   "maximized" are two surface view keys of the landing pane
   (`;view.website.demo=…;view.website.demo.full=1`). This needed one primitive
   change: `usePaneViewParam(...).set(value, "push")`, because a view param only
   replaced the history entry before. The history rule is /demo's:
   - framed, a move replaces the entry;
   - maximized, each move is the history mode the embed reports;
   - Maximize and Restore push an entry.

   A new browser tab opened from inside opens the homepage there, maximized
   (`browserTabUrl`). Before, it opened the real app's path.
5. **Esc restores, as the lowest-precedence page shortcut.** The new
   `shortcuts`' `usePageShortcuts` registers it page-wide at precedence -1. The
   shortcut manager's existing rule then decides who gets Esc:
   - an Esc that was already handled fires nothing. Radix menus and dialogs
     `preventDefault` the Esc they close on;
   - a text field claims a plain Esc;
   - any other eligible Esc shortcut wins: solo exit, desktop overview, a tour.

   So Esc goes to the innermost thing that wants it, and restores only when
   nothing inside the demo does. One consequence: Esc while typing in a field
   does not restore. Restore is still at the top edge.
6. **Maximize and Restore animate as a view transition** (`morphDemoFrame`,
   modelled on `apps-core/pane-morph`). The demo's box (`DEMO_FRAME_ATTR`) grows
   to the surface and shrinks back. Its pictures are pinned top-left and
   clipped, never stretched. Back / Forward switch without it.
7. **"Press Esc to restore" notice.** It shows each time the demo is maximized
   and fades out after about 4 s. It is a pure CSS animation, with no timer.

Points 5 to 7 are one shared kit in `apps/demo/chrome` (`MaximizedChrome`,
`morphDemoFrame`), used by /demo and the website.

## Verified

- `live-demo.ts` (23 checks) and `location-in-demo.ts` (58 checks) pass.
- The other demo e2e scripts were updated for the gate.
- A new jsdom test covers the background start behind the gate.
