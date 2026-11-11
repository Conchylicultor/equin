# An embedded app keeps its own place in the page URL

## Context

Two hosts of `<AppEmbed>` each spelled the embed's place in the page URL their
own way:

- `/demo` — a route of its own, `/demo/at/<location>[;full=1]`
  (`apps/demo/shell`'s `demoAtRoute` + `demo-at.tsx` writing it from
  `onLocationChange`);
- the website's homepage band — two pane view params,
  `/website;view.website.demo=%2Fagents%2Fc%2Fx;view.website.demo.full=1`
  (`landing/screenshot/web/internal/demo-place.ts`).

Root cause: `AppEmbed` only *reported* its location (`onLocationChange`) and
took an address for new tabs (`browserTabUrl`); every host had to persist it.
Nothing made a default, so two hosts built two spellings.

User decision: one mechanism, by default. The embed writes its own place into
the page URL, in one grammar; a page that embeds an app writes no URL code.

## Design

### The grammar (pane core — `route.ts`)

The embed's place belongs to the **pane instance that hosts it**, as two
reserved surface views of that instance (`EMBED_PLACE_SURFACE = "embed"`,
`EMBED_MAXIMIZED_SURFACE = "embed.full"` → keys `view.embed`,
`view.embed.full`). Surface views already ride every pane instance — the
landing (index) pane's on its base path — through the store, history
snapshots, tab persistence and restores, and `setKeyedParam` writes one in
place with a push or replace. So the plumbing exists; only the spelling is new.

When those keys sit on the route's **last** instance (its last slot, or the
landing pane when the route has none — both hosts today), `buildRouteUrl`
writes them as a trailing tail instead of `;view.…` pairs:

```
<the page's own URL>/at/<location parts>[;full=1]
/about/at/agents/c/x;full=1        /demo/at/desktop/sonata   (the site moved from /website to /about the same day)
```

Location parts are encoded per part (`wildcardParts`), so a raw `;` in the
tail is always ours. On a non-last instance, or `full` with no location, they
stay ordinary `;view.embed…` pairs — both spellings parse back to the same
route.

`parseUrl`: the plain chain parse first (so `/files/<fs>/at/…` and any route
with a real `at` segment keep matching); only when that fails, the first
`at` part whose prefix parses as a chain is the tail, put on the prefix's last
instance (or the landing pane's params).

`/demo/at/<loc>;full=1` is exactly the new grammar over `/demo`'s landing
pane — old /demo links keep working with no redirect.

### Pane web

- `PaneStore.setKeyedParams(pane, instanceId, values, history)` — several keys
  in one history entry (`setKeyedParam` becomes its one-key form), and
  `keyedParamsHref(…)` — the URL that write would produce.
- `usePaneViews(surfaces)` → `{ values, set(views, history?), href(views) } |
  null`, the multi-surface form of `usePaneViewParam` (same `null` rule).

### `apps-core/app-embed`

- `AppEmbed` binds its place itself (`usePaneViews([place, maximized])`):
  seeds from the URL, writes each move (framed: replace; maximized: the app's
  own push/replace — task-1794267528's rule), follows the URL on Back/Forward,
  and addresses a new browser tab as this page at that place, maximized
  (`href`, under the active route prefix). Outside any pane (a test, an
  exhibit stage with no address) it keeps its place in memory.
- Public props lose `url`, `onLocationChange` and `browserTabUrl`; `app` /
  `route` stay as the seed for an embed with no place in the URL yet.
- `useEmbedPlace()` → `{ maximized, setMaximized(on), reset() }` for the host's
  chrome (Maximize, Restore, Reset), reading the same keys. Throws outside a
  pane. One embed per pane instance persists (documented).
- `EmbeddedTabSet`'s `onLocationChange` / `location` / `browserTabUrl` stay as
  the tabs layer's internal channel — `AppEmbed` is now their only user.

### Hosts

- `/demo`: `demoAtRoute` / `demoAtPane` / `DemoStart`'s redirect and
  `internal/location.ts` deleted; the landing pane (`/demo`) renders the
  framed/maximized demo, reading `useEmbedPlace()`.
- Website band: `demo-place.ts` deleted; `LiveDemoSection` reads
  `useEmbedPlace()`. A legacy redirect (`legacy-demo-place.ts`, marked for
  removal) moves `;view.website.demo=…;view.website.demo.full=1` onto the new
  keys in one replace before the band renders.

## Verification

- Unit: `pane/core/route.test.ts` / pane web tests for build/parse round trips
  (index owner, slot owner, non-last owner, `full` without location, Files-like
  `at` segments still match); `app-embed.test.tsx` updated to the URL binding.
- `./equin check`, `./equin build`, `./equin build --composition website`.
- e2e: every `apps/demo/e2e/*` script, `live-demo.ts` (updated to the new
  URL; an old-link redirect step), `site-parity.ts`, `places-in-demo.ts`.

## Outcome (2026-11-11)

Landed as designed, plus three refinements:

- **`;full=1` is its own flag** on the URL's last part, with or without a
  location (`/demo;full=1` maximizes before any move). `full` is reserved:
  no route may declare it.
- **A last segment that ends open** (wildcard / optional) keeps the plain
  `;view.embed…` keys, since a tail after it would read as its value
  (found by the review).
- **Rebased over 0b8abbe597**, which made an embed write no place it opened
  at by itself. That rule now holds for every host: bare `/demo` stays
  `/demo` until the visitor moves (it used to settle on `/demo/at/home`),
  as `/website` does. `useEmbedPlace().named` tells the website band to
  resume with no gate when the URL names the demo.
