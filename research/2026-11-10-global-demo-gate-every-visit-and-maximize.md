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

## Follow-up: a maximized place opened fresh, and a new tab from inside

The problem: a reload of a maximized URL (`/demo/at/…;full=1`,
`/website;…;view.website.demo.full=1`), or a new tab opened from inside the
demo, drew the gate in the small frame. The demo became maximized only after
Enter, with no morph, so the visitor could not tell where they were going.

**The rule.** Enter equin is asked once per *visit*. A visit lasts while the
visitor is in the demo in any tab of this browser.

1. **The gate is drawn where the demo will be.** A maximized URL draws its
   gate (and the boot bar after it) maximized: the whole page on /demo, and
   over the tab's surface on the website. Enter then opens the demo in
   place, with nothing to move.
2. **A tab opened while the visitor is in the demo joins it with no gate.**
   This covers a link from inside opened in a new tab, or a second tab of the
   page. The visitor already chose to enter, and the new tab shares the same
   SharedWorker and data. A tab opened when no other tab is in the demo
   (a reload of the only tab, a fresh visit) still asks.

**How "in the demo elsewhere" is known.** Each tab whose visitor is in
(entered at the gate, or joined) holds a shared Web Lock,
`demo-visitor-in <scenario id>`
(`browser-server/demo/scope/web/internal/presence.ts`). A tab opening a gated
`DemoScope` asks `navigator.locks.query()` whether anyone holds it. This
needs no message and no reply to wait for. A closed or crashed tab releases
the lock by itself. Before the answer arrives (a few ms), `DemoBoot` is
`checking` and the boot screen shows the logo alone.

Other options were rejected:
- A URL marker such as `;entered=1` would also skip the gate for anyone the
  link is shared with.
- sessionStorage is not copied to a ⌘- or middle-click tab.
- A BroadcastChannel ping needs a reply timeout.

`DemoScope`'s `onEnter` hears both ways in. The website band grows its frame
on it, so a joined band is grown too.

**Verified.**
- `location-in-demo.ts` (60 checks): the new tab joins with no gate; a fresh
  maximized URL shows its gate maximized.
- `live-demo.ts` (27 checks): a maximized reload draws the gate over the tab,
  Enter opens the demo maximized on Pages, and a second tab joins with no gate.
- `persistence.ts`: the second tab joins.
