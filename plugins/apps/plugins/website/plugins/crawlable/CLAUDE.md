# crawlable

What a robot can know about the website without running it: which pages there
are, what each is called and says, and a static snapshot of each
(`research/2026-11-10-global-website-crawlable-v3.md`).

## A page is declared once

```ts
// pages/<page>/core/page.ts
export const downloadPage = defineWebsitePage({
  path: "/about/download",           // static, under /about, no trailing slash
  title: "Download",                   // the pane title: tab + document title
  description: "How to run your own copy of equin…",
});

// pages/<page>/web/panes.tsx  — a website pane: the route its path gives, as literals
export const downloadPane = Pane.define({
  route: defineRoute({ id: "website-download", segment: "download" }),
  app: websiteApp,
  actions: WebsiteHeader,
  title: downloadPage.title,
  component: DownloadBody,
});

// pages/<page>/server/index.ts
contributions: [WebsitePages.Page(downloadPage)],
```

- The route is written out, not built from the page: `pane:identity-manifest`
  pins every pane's id, segment and `appIndex` by reading them from source as
  literals, so a pane factory deriving them from data would be unreadable
  there. The derivation lives in the check instead (`websitePaneIdentity`):
  segment = path relative to `/about` (`""` for the landing page, the only
  one with `appIndex: true`), route id `website-<segment>` (`website-landing`).
- The website app's `basePath` is this plugin's `WEBSITE_BASE_PATH`, so a page
  path and its app cannot disagree.
- **`crawlable:pages-declared`** (check): every `defineWebsitePage` binding has
  exactly one website pane (a `Pane.define` with `app: websiteApp`, naming its
  page by `title: <page>.title`) and one `WebsitePages.Page(…)`; every website
  pane and server entry names a declared page (by binding name, held unique);
  each pane's inline route literals and `appIndex` are the ones its page's path
  gives; paths are string literals and unique.

## `/robots.txt` and `/sitemap.xml`

Public raw endpoints at the ROOT (`GET /robots.txt`, `GET /sitemap.xml` —
routes need not start with `/api/`), built per request from
`WebsitePages.Page`, the origin from `X-Forwarded-Host` (else `Host`) + `X-Forwarded-Proto` (`http`
unless it says `https`). A composition with no page answers 404 (read by
crawlers as allow-all). The gateway forwards only `/api/` and `/ws/` today;
forwarding these two exact paths is step 4.

## The snapshot manifest — the contract

`SnapshotManifestSchema` (core) is the shape of `<dist>/snapshot/manifest.json`
(`SNAPSHOT_MANIFEST_PATH`): written by the snapshot build, read by the
gateway's `snapshot.go`, which mirrors it.

```json
{ "home": "/about", "pages": { "/about/download": { "title": "Download", "description": "…", "file": "about/download.html" } } }
```

Keys are exact page paths (no trailing slash; the gateway normalizes the
request's). `file` is a `.html` fragment relative to the manifest's directory,
never escaping it. `home` is the composition's home — its home app's base
path, the app `/` goes to, derived by the take from the composition's
`home` (static-render's `renderer.home`), never written here — and the
gateway answers bare `GET /` with a 301 to it, so a robot reaches the
snapshot from the site's most-linked address; it is never `/` and always one
of `pages` (absent: no home). Strict at both levels: an unknown field is an
error, so writer and reader change together.

## The snapshot — taken by the build, only for a crawlable composition

A composition declared `crawlable: true` (its row in
`plugin-meta/composition/core/config.ts`; today only `website`) gets its pages
rendered once, for robots, by its build (`./equin build --composition
website`, a release of it). Main's build and an ordinary worktree's never run
it. Three parts:

- **The take — `bin/static-host.ts <composition> <out-dir> <cluster>`**, run in
  a fresh Bun process by web-artifacts' `artifacts:crawl-snapshot` stage. It
  boots the composition's portable server graph in-process on PGlite (opened
  from the build's initialized cluster — no initdb), assembles its boot
  snapshot in-process (`assembleBootSnapshot`: the
  `/api/resources/boot-snapshot` body), reads `WebsitePages.Page`, renders, and
  writes `snapshot/<page>.html` fragments then `snapshot/manifest.json` last
  (temp + rename). No live server, nothing of main's.
- **Its graph — `bin/static-host.generated.ts`** (`staticHosts`, per crawlable
  composition), written by codegen's `static-host-gen.ts`: the browser-host
  graph inference (`resolveHostGraph`) over the composition, admitting every
  portable barrel the graph's code reaches, plus the composition's web plugins
  and identity. The take boots it through `framework/browser-server/bun-host`'s
  `withDiskProviders`, which swaps the two bundled-text providers (migrations,
  committed config) for the same files off disk — the workspace demo's take
  does the same. Held by `plugins-registry-in-sync`.
- **The render half — `plugins/snapshot-render`'s `renderSiteSnapshot`**
  (web), loaded by the take by path through barrel-import (a `bin/` imports
  no `web/`): `createStaticRenderer`
  over the composition's web plugins, each page rendered **by its path alone**,
  filtered by `semanticHtml`, titled with `apps-core/core`'s `documentTitle`
  (the one spelling the live app's `DocumentTitleSync` writes into
  `document.title`), checked by core's `snapshotFiles` (a page with no text,
  or any render error, throws `SnapshotPageError` naming the page). **It is
  build-only, so it is in no composition**: base-exclusions negates
  `apps.website.crawlable.snapshot-render.**` and
  `primitives.dom.static-render.**`, so neither is in any browser registry
  (main's `web.generated.ts` included) and no browser downloads the
  renderer, the semantic filter or htmlparser2. The snapshot's address
  covers it as a web barrel of the take's own plugin subtree. `crawlable`
  itself has no `web/`.

An imported image is the `data:` URL the browser build gives it (vite's
library mode inlines every asset): the take calls barrel-import's
`inlineAssetImports()` before loading anything, so a render never holds a
path on this machine — and `semanticHtml` keeps no `data:` image, only its
alt (a figure caption, or a link's text), so a fragment is the page's words,
not its pixels.

**Cache.** One store entry per address (`<composition>.crawl-snapshot.<hash>`,
shared by every checkout): the take's, its render half's and the
composition's web code (module graph Merkle keys), the data they read (every glob root those modules declare
— the swapped providers' migrations and config), npm resolutions, patches, the
Bun version and the cluster. An unchanged tree is a cache hit: no process
runs. Compose links the entry into the dist (`artifacts/<dir>`, a prune root)
and its `snapshot/` at the dist root, where the gateway reads
`<web>/snapshot/manifest.json`.

Run the take by hand (any initialized cluster file from the store):

```bash
./equin run plugins/apps/plugins/website/plugins/crawlable/bin/static-host.ts \
  website "$EQUIN_SCRATCH/crawl" ~/.equin/cache/web-artifacts/store/pglite.pglite-cluster.<hash>/cluster.tar.gz
```

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./equin build` -->

## Plugin reference

- Description: The website's pages on the server: the WebsitePages.Page collection every page plugin contributes its defineWebsitePage declaration to, and the public /robots.txt (allow all, pointing at the sitemap) and /sitemap.xml (one URL per page) built from it per request, origin from the request's X-Forwarded-Host (else Host) and X-Forwarded-Proto; both 404 in a composition with no pages.
- Server:
  - Uses: `infra/endpoints.rawEndpointHandler`
  - Exports (values): `WebsitePages`
  - Routes:
    - `GET /robots.txt`
    - `GET /sitemap.xml`
- Core:
  - Uses:
    - `infra/endpoints.blob`
    - `infra/endpoints.defineEndpoint`
  - Exports (types):
    - `SnapshotManifest`
    - `SnapshotPage`
    - `SnapshotTaken`
    - `WebsitePage`
  - Exports (values):
    - `defineWebsitePage`
    - `fragmentText`
    - `robotsTxtEndpoint`
    - `sitemapXmlEndpoint`
    - `SNAPSHOT_MANIFEST_PATH`
    - `snapshotFileOf`
    - `snapshotFiles`
    - `SnapshotManifestSchema`
    - `SnapshotPageError`
    - `SnapshotPageSchema`
    - `WEBSITE_BASE_PATH`
    - `WebsitePageError`
- Cross-plugin:
  - Imported by:
    - `apps/website/crawlable/snapshot-render`
    - `apps/website/pages/apps`
    - `apps/website/pages/download`
    - `apps/website/pages/foundations`
    - `apps/website/pages/guide`
    - `apps/website/pages/privacy`
    - `apps/website/pages/story`
    - `apps/website/pages/vision`
    - `apps/website/shell`
- Sub-plugins:
  - **`snapshot-render`** (excluded) — The crawlable snapshot's render half, build-only: renderSiteSnapshot renders each declared website page once by its path through the real app (static-render over the composition's plugins and a boot…

<!-- AUTOGENERATED:END -->
