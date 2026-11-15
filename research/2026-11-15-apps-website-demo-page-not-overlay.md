# The homepage's maximized demo is its own page, not an overlay

## Context

`/about/at/agents;full=1` drew the maximized live demo as a `SurfaceOverlay`
over the whole homepage: every landing section stayed mounted behind it (the
hero film's `<video>` and its 206 KB poster included). And `;full=1` made
"maximized" part of the address, so one place in the demo had two URLs — a
link shared from a framed demo opened the homepage, one shared maximized
opened the demo.

Rule: **a URL names one screen.**

- `/about` is the homepage with the demo framed in it. Moving inside the
  framed demo never touches the URL (its place is kept in memory); a reload
  shows the gate again, as any visit.
- `/about/demo` is the demo on its own page — nothing of the homepage is
  mounted. Its place is the page's embed tail, the grammar every embed host
  already uses: `/about/demo/at/agents/c/x`. Each move inside is a history
  entry (the demo is the page, as the app's own tab).
- Maximize = navigate to `/about/demo[/at/<place>]` (pushed), inside the
  existing morph. Restore / Esc = navigate to `/about` (pushed), scrolled to
  the frame. Back from the demo page walks its moves, then returns to `/about`.
- A new browser tab opened from inside the demo (framed or not) opens
  `/about/demo/at/<place>`.
- No backward compatibility: `/about/at/…`, `;full=1` on `/about` and the
  older `;view.website.demo=…` rewrite (`legacy-demo-place.ts`) go.

`/demo` (the sandbox app) is unchanged; it keeps its own `;full=1`.

## Design

### 1. The demo's server outlives the page switch — a resident host

`DemoScope` unmounting disposes the server and leaves its SharedWorker; the
last tab leaving retires the worker. So the scope cannot live in either page:
it lives in the website app's surface (`WebsiteLayout`, mounted across every
site page), and the embed is **portaled** into whichever page shows it.

- `apps/website/shell` gains `Website.Resident`: components mounted once by
  the app's surface, alongside `Website.Layer`, kept while the visitor moves
  between pages. Generic — the shell names nothing.
- New plugin `apps/website/live-demo` owns the demo's runtime:
  - a module store (`useSyncExternalStore`) of the **current target**: the
    element to draw into, which page it is (`framed` | `page`), and the
    page's place binding; plus the session state: `entered` (the visitor
    came in — the frame stays grown), the framed place (memory), and a
    pending "restore: scroll to the frame".
  - `DemoResident` (the `Website.Resident` contribution): mounts nothing
    until a target has registered once (other site pages never start the
    worker), then keeps one `<DemoScope scenario={workspaceDemo}>` for the
    rest of the visit; `resume` = the first target is the demo page. Its
    `boot` and its children are portaled (keyed by the target) into the
    target; with no target (another site page) it draws nothing and the
    server keeps running.
  - `<DemoTarget kind>`: the box a page draws the demo in — registers its
    element on mount (ref callback, so a `flushSync` navigation inside the
    morph has the new target before the transition's snapshot), carries
    `DEMO_FRAME_ATTR`, and draws the boot screen's `checking` state while no
    resident has claimed it (a static render: the crawlable snapshot).
  - the demo pane, `/about/demo` (`segment: "demo"`, no site header, no
    footer): `<DemoTarget kind="page">` filling the surface, its place bound
    to the pane's embed tail with push semantics; draws `MaximizedChrome`
    (Restore, the Esc notice).
  - the controls the running demo draws under the frame (Maximize, Reset),
    rendered by the resident into a controls slot the frame registers.

### 2. `AppEmbed` takes its place binding from the host

Today `AppEmbed` reads the enclosing pane's views for its place. Portaled
from the layout it has no pane, so the place becomes a prop:

```ts
interface EmbedPlaceBinding {
  location: string | undefined;          // where it is, as the host keeps it
  onLocationChange(url: string, history: HistoryMode): void;
  browserTabUrl(url: string): string;    // a new browser tab from inside
}
<AppEmbed place={binding} … />           // omitted: the enclosing pane's tail (today's behaviour)
```

Exactly `EmbeddedTabSet`'s fields (`apps-core/tabs`), so the tab set is
unchanged. `/demo` keeps the default.

- Framed: `location` = the store's memory place; `onLocationChange` writes it
  there; `browserTabUrl` = the demo pane's link at that place.
- Demo page: `location` = the pane's embed tail (`usePaneViews`,
  `EMBED_PLACE_SURFACE`); `onLocationChange` writes it with the move's own
  history mode (push for a link, replace for a redirect); `browserTabUrl` =
  the pane's `href`.

A target switch remounts the embed (a new portal container), which reopens at
the binding's location — as maximizing does today. Maximize copies the
memory place into the URL; Restore copies the URL's place into memory.

### 3. The band

`landing/screenshot`'s `LiveDemoSection` keeps the frame's growth and the
caption row, but owns no scope: it draws `<DemoTarget kind="framed">` sized
as today (grown from the start when `entered`), the controls row, and, on a
pending restore, reveals the frame at once (no smooth scroll: the morph is
the motion). Enter at the gate grows and scrolls as today (`onEnter` from
the resident → the store).

## Files

- `plugins/apps-core/plugins/app-embed/web/components/app-embed.tsx` — `place` prop, `EmbedPlaceBinding` type; CLAUDE.md.
- `plugins/apps/plugins/website/plugins/shell/web/{slots.ts,components/website-layout.tsx}` — `Website.Resident`.
- `plugins/apps/plugins/website/plugins/live-demo/` (new) — store, resident, target, demo pane.
- `plugins/apps/plugins/website/plugins/landing/plugins/screenshot/` — band over `DemoTarget`; delete `legacy-demo-place.ts`; CLAUDE.md, `e2e/live-demo.ts`.

Reused: `DemoScope` / `DemoEntry` (`browser-server/demo/scope`),
`DemoBootScreen` / `MaximizedChrome` / `morphDemoFrame` / `ResetDemoButton` /
`DEMO_FRAME_ATTR` (`apps/demo/chrome`), `revealElement`, `useClaimTabTitle`,
`usePaneViews` + `EMBED_PLACE_SURFACE`, `track`.

## Verification

- `./equin check`, `./equin test plugins/apps-core/plugins/app-embed`.
- `./equin build`, then the updated `landing/screenshot/e2e/live-demo.ts`:
  gate → Enter (frame grows, URL stays `/about`) → move inside (URL still
  `/about`) → Maximize (URL `/about/demo/at/<place>`, no landing section in
  the DOM, same worker) → move (pushed) → Back → Restore (`/about`, frame at
  the same place, scrolled to it) → reload `/about/demo/at/<place>` (no gate,
  no landing section, no hero video request).
- `register_before_after` on `/about/demo/at/agents`.
