# No string spelling of a route in scoped web code

Task: task-1793817984-v5eya0 (sidequest of task-1793813670-6qj55r). Track:
"apps running in the browser" (wiki block-d04c6c0d-…).

## Context

Inside `<DemoScope>` every server call must go through the subtree's transport
(the worker). An element that loads a URL by itself (`<img src>`, a popup, a
`<link href>`) does not: a plain `/api/…` string loads from the page's origin,
i.e. the real server. Sonata's covers did this with `endpointPath(…)`. The
coverage guard accepted it because the route is served by the worker graph. The
request guard deliberately ignores element loads. The no-leak e2e never opened
Sonata.

The covers are fixed. The class is not. Today these spellings turn a route into
a string anywhere `core/` or `web/` reaches:

| Spelling | Where it is reachable from web | Callers found |
|---|---|---|
| `endpointPath(def, params)` (endpoints core) | any web/core | auth `connect.ts` (popup URL), app-manifest core (head HTML, server-only use), scratch workspace (server) |
| `def.path` (public field) | any web/core | jsonl-viewer `transcriptImageUrl` → `ViewerThumbnail src` (3 web rows: **a live leak** for transcript images), host-fs image `hostResizedUrl` → image viewer `resized` (web), paste-images persisted markdown, analytics / site-messages host-only paths (server users), cli, e2e |
| `interpolatePath` / `extractPath` (core barrel) | any web/core | the same three core helpers, prototypes cli |
| `endpointRequest(def).path` (core) | any web/core | boot snapshot, health, ndjson (all `transport.fetch(path)`), mcp browser revert (host process) |
| hand-typed `"/api/…"` literal | scoped code | the coverage guard flags it only when the worker does NOT serve the prefix |

## Design: take the spellings away (rung 1), lint-free

1. **Endpoint defs carry no public path.** Drop `path` from `EndpointContract`.
   endpoints' own code derives it with `routePath(def)` (`core/internal/route-path.ts`,
   a module the core barrel does not export).
2. **Route → string builders live only off the page.** `endpointPath` and
   `interpolatePath` are exported from `endpoints/server` (server, machine, cli,
   check, bin, scripts) and from a new `endpoints/e2e` barrel (e2e scripts). Both
   barrels re-export the one implementation file. `extractPath` / `extractMethod` /
   `interpolatePath` / `endpointPath` leave the core barrel. web, core and shared
   code have no import path to any of them.
3. **The request core takes a fetcher, not a path.** `endpointRequest` → `sendEndpointRequest(fetcher, def, params, opts): Promise<Response>`
   with `fetcher: { fetch(path, init) }`. A `Transport` is one as is. The path
   only ever reaches a function named `fetch`. Callers: `fetchEndpoint` (web),
   `callEndpoint` (server), boot snapshot, health, read-ndjson, mcp revert.
4. **What an element loads is an `AssetPath`** (the existing primitive):
   - `transcriptImageUrl(key): string` → `transcriptImage(key): AssetPath`. The
     three web rows render `AssetThumbnail`, not a string `ViewerThumbnail`.
   - `hostResizedUrl(…)` → `hostResizedAsset(…): AssetPath`. `use-folder-images`
     resolves it with `assetUrlOver(transport, …)` (the image viewer loads by URL
     by itself). With no ready URL, the viewer keeps the original.
   - auth connect: `startConnectFlow(transport, args)` builds
     `assetPath(oauthStart, { provider }, query)` (`query` is now declared on
     `oauthStart`) and opens the popup only on `assetUrlOver`'s `ready` URL.
     Otherwise it fails with the transport's message.
5. **Persisted addresses are markdown, not URLs.** `documentLink(endpoint, params, { text, image })`
   (endpoints core) writes a `[text](path)` / `![text](path)` markdown fragment.
   paste-images builds its attachment markdown with it. The text that comes out
   is a document, read back by the markdown sinks that already treat `/api`
   addresses specially. It is never a `src`.
6. **Server-only helpers move to their users.** app-manifest's path helpers and
   `appManifestFor` → `app-manifest/server` (menu-bar's machine half imports
   `appIconPath` from there). `analyticsQueryPath` and `siteMessagesListPath`
   move into the dashboard and inbox server halves, which call `endpointPath`.
   Importing collect/intake `server` would pull a deployed site's tables into
   the local app.
7. **Hand-typed literals: the guard refuses them in scoped code.** The coverage
   guard's raw-`/api` arm today passes a served prefix. A served prefix is
   exactly the leak, because a literal URL in a non-page-bound scoped module can
   only be an element load (fetches are already banned by `no-raw-web-fetch` and
   the request guard). It now fails on every raw `/api/<seg>` literal in scoped,
   non-page-bound code, served or not, and points at `AssetPath`. The one
   exception is the resource runtime's own route, which live-state builds for
   `transport.fetch`. A typed literal cannot be made inexpressible, so a check
   is the highest available rung for it.

Residual (recorded, not guarded): hand surgery on `def.route`
(`"GET /api/x".split(" ")[1]`); a literal that does not START with `/api/`
(`` `${origin}/api/x` ``, `base + "/api/x"`), which the guard's literal scan
does not see; and an abusive sender callback that keeps its path.

## The no-leak e2e catches the class

- After its steps, it opens **every app the demo's launcher lists**, waits for
  the network to settle, and keeps recording page-origin `/api` requests. An
  `<img>` / `<link>` load is a request Playwright sees, so the Sonata covers
  regression fails it. Each app visit is reported.
- The e2e harness gets `report.skip(name, reason)`. It prints `SKIP`, is counted
  apart from passes (`ALL CHECKS PASSED (29 passed, 2 skipped)`), and lists the
  skips. no-leak's host-dependent launch options (absent, disabled, or nothing
  to pick) are skips, never silent notes and never passes. Per the supervisor,
  nothing is built around the empty preprompt picker; preprompts come back with
  task-1793815416-2se0k2.

## Verification

- `./equin build` (the guard green), `./equin check`.
- `./equin test plugins/infra/plugins/endpoints plugins/infra/plugins/host-fs/plugins/image plugins/framework/plugins/tooling/plugins/codegen`.
- e2e: `apps/demo/e2e/{no-leak,app-switch,prototypes-in-demo,sonata-in-demo}.ts`
  and the lumen boot test. To prove that no-leak catches the class, temporarily
  revert one Sonata cover to `src={endpointPath…}` and confirm it fails (done
  by hand, not committed).
- Desktop smoke: a transcript image, an account's Connect popup URL, the app
  manifest `<link>`.
- `/website` must not change (supervisor rule): none of these files feed it.
  `analytics/collect` and `site-messages/intake` change only their core
  helpers, which the website does not import.
