# static-render

Render a pane of the app ONCE, to HTML that is never hydrated, and filter it
down to the document a robot reads. The engine behind the crawlable website
(`research/2026-11-10-global-website-crawlable-v3.md`, step 2).

```ts
// web — run in a host process (Bun), loaded through barrel-import
const renderer = await createStaticRenderer({
  entries,      // the composition's PluginEntry[] (web loader thunks)
  composition,  // its CompositionIdentity
  bootSnapshot, // { resources, tuples } — the boot-snapshot endpoint's body
});
renderer.unhydrated; // snapshot keys no loaded plugin declares
renderer.home;       // the composition's home app { id, name, basePath } (null: none)
const { html, title, paneId, app } = await renderer.render({ path: "/website/download" });
await renderer.render({ pane: downloadPane, path: "/website/download" }); // asserts the pane

// core — pure
semanticHtml(html); // h1–h6, p, a[href], lists, blockquote, pre/code, tables, figure, img[alt], strong/em, br
```

## `createStaticRenderer` — the real app, minus the browser

Its steps run in a fixed order, so none can be done out of turn:

1. **`declareRenderMode("static")`** (`dom/render-mode`), before any plugin
   loads — building blocks then write into the markup what a click would
   compute (link-gesture's `data-link`, collapsible's closed content).
2. **`loadPlugins(entries)`** — the web loader itself; any load error throws.
3. **The page's live-state pipeline** (`ensureNotificationsClient`) over a
   transport with no server behind it (`web/internal/static-transport.ts`),
   then **`hydrateBootSnapshot`** — the boot task's own hydrate path
   (`network/live/boot-snapshot`). A value its schema rejects throws; keys no
   loaded descriptor claims are returned as `unhydrated`.

Once per process: the render mode and the page's pipeline are process-wide.

`render({ path, pane? })` resolves the path's app — the registered app
(`Pane.Register`'s panes' `AppRef`s) with the longest base path holding it, or
`pane`'s own app when given — and mounts the provider stack the app mounts —
`TransportProvider` → `NotificationsProvider` → `PluginProvider({ plugins,
composition })` → `PaneSurfaceProvider` over a background pane store
(`createPaneStore({ live: false })`) seeded with `path` — and paints the
matched pane with the real full-surface renderer (`layouts/full-pane`), through
react-dom's `prerender` (`react-dom/static`: it waits for every `lazy` /
Suspense to settle, where `renderToStaticMarkup` would print the fallback).

**Fails loudly**, as a `StaticRenderError` naming the pane, the path and the
component path (React's component stack):

- `path` held by no registered app, outside the given pane's app, resolving
  to no registered pane, or (with `pane`) to another pane;
- any error thrown while rendering — inside a Suspense boundary too (React
  would otherwise render the boundary's fallback and carry on);
- any request or socket the render reaches for: the transport throws, and
  records it, so a swallowed rejection still fails the page. A static render
  reads only what the boot snapshot hydrated.

`title` is the pane's own `Pane.define({ title })` (via `usePaneTitle`),
`undefined` when it declares none; `paneId` the pane the path resolved to;
`app` its app's id and display name (what a document title is built from —
`apps-core/core`'s `documentTitle`).

`react-dom/static` is imported lazily inside `render`, so the web barrel
costs a browser bundle nothing until a static render runs.

### No stubs

Nothing is faked: every provider is the app's own. What made that possible
was fixed in the building blocks (step 1 of the plan, plus the pane store's
server snapshot below), each with a test that statically renders it:
`useSyncExternalStore` server snapshots, a `NotificationsClient` that opens no
socket until `connect()`, portals rendered in place, no DOM globals in render.

- **The pane store is the route's truth on the server too.** `useRoute` /
  `useRouteState` / `useIndexMatch` pass the store's own snapshot as
  `getServerSnapshot` (they used to pass a constant empty route, so every
  static render resolved to the app's index pane). The app never hydrates
  server markup, so there is no mismatch for a constant to protect.

## `semanticHtml` — the document under the markup

Keeps `h1`–`h6`, `p`, `a[href]`, `ul`/`ol`/`li`, `blockquote`, `pre`/`code`,
`table`/`thead`/`tbody`/`tr`/`th`/`td`, `figure`/`figcaption`, `img` with a
non-empty `alt` (`src` + `alt` only), `strong`/`em`, `br`.

- **An image is kept as `<img src alt>` only when its `src` is an address**
  (http(s) or root-relative). A `data:` URL (the build inlines every imported
  asset as one — the Apps page's icons made its fragment ~170 KB) or no `src`
  is replaced by its alt: `<figure><figcaption>alt</figcaption></figure>`
  where a figure may stand (the static media player's shape), the alt as text
  where it may not (inside a link — the link's text —, a paragraph, a heading,
  a figure). An empty alt is decoration and goes.

- **`data-link` → `<a href>`** around the element's content (a kept element
  keeps its tag, the link inside). Links never nest: an inner one is unwrapped.
- **Dropped with their subtree**: `svg`, `canvas`, `script`, `style`, form
  controls (a control carrying `data-link` is kept as a link), media, the
  document head, anything `aria-hidden="true"`. Content under `hidden` stays —
  a closed fold's text is content.
- **Unwrapped**: every other element. A box (`div`, `section`, `span`, …)
  separates its text from its neighbours by a space; text-level markup (`b`,
  `sub`, `mark`, …) does not. A `span` edge a word is written straight against
  (`equin<span>.</span>`, `<span>$</span>5`) is no boundary either: the author
  wrote one run of text, styled in part (the website's wordmark). A kept
  element left with no text and no image is an empty wrapper and goes.
- **Top-level text is a paragraph**: an inline run left between blocks at the
  document's top level ("More details soon" in a `div`, a row of links) is
  wrapped in `<p>`; a run holding a block (a link around a card) stays as is.
- **Whitespace** collapses to single spaces (verbatim in `pre`); each block
  ends its line.
- **Values pass through verbatim** (htmlparser2 with `decodeEntities: false`):
  text and attributes stay the React serializer's escaped source, never decoded,
  so nothing can be decoded twice or emitted raw.

Parser: `htmlparser2`, already the repo's portable HTML parser
(`infra/html-decode`); its streaming events are all the filter needs (no DOM).

## Tests

- `core/internal/semantic-html.test.ts` (bun) — the filter, rule by rule.
- `web/__tests__/static-renderer.test.tsx` (jsdom) — a fixture app end to end:
  index and segment paths, `data-link`, the title, and every failure above.

The real website end to end: its crawl snapshot take
(`apps/website/crawlable/bin/static-host.ts`), run by `./equin build
--composition website`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: One static render of a pane to HTML for robots (never hydrated): createStaticRenderer declares the process a static render, loads the composition's plugins, hydrates a boot snapshot through the boot task's own hydrate path, and renders a path through the real provider stack and a static pane store, failing loudly with the pane and the component path.
- Excluded: yes
- Web:
  - Uses:
    - `layouts/full-pane.FullPane`
    - `network/live/boot-snapshot.BootSnapshotValues`
    - `network/live/boot-snapshot.hydrateBootSnapshot`
    - `network/live/live-state.ensureNotificationsClient`
    - `network/live/live-state.NotificationsProvider`
    - `primitives/networking.TransportProvider`
    - `primitives/pane.AnyPane`
    - `primitives/pane.createPaneStore`
    - `primitives/pane.MatchEntry`
    - `primitives/pane.Pane`
    - `primitives/pane.PaneSurfaceProvider`
    - `primitives/pane.stripBasePath`
    - `primitives/pane.usePaneMatch`
    - `primitives/pane.usePaneTitle`
  - Exports (types):
    - `StaticPage`
    - `StaticRenderer`
  - Exports (values):
    - `createStaticRenderer`
    - `StaticRenderError`
    - `StaticRenderNetworkError`
- Cross-plugin:
  - Imported by: `apps/website/crawlable/snapshot-render`
- Exemptions:
  - Exempts itself from: `networking/no-page-transport` — `web/internal/static-renderer.tsx` (sanctioned)
- Core:
  - Exports (values): `semanticHtml`

<!-- AUTOGENERATED:END -->
