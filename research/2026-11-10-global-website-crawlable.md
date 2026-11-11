# Make the public website crawlable: robots.txt, sitemap.xml, a static snapshot of each page

## Context

Another Claude session failed to read https://equin.ai/website/foundations ("Site disallows automated access"). What we have today:

- We block nothing: `ClaudeBot`, `Claude-User`, `GPTBot` and `Googlebot` all get 200.
- **There is no robots.txt.** The gateway's `handleStatic` (`gateway/proxy.go:225-266`) answers every unknown path with the SPA shell and a 200: `/robots.txt`, `/sitemap.xml`, `/anything`. When a crawler fetches robots.txt during a backend restart and gets a 5xx, RFC 9309 tells it to treat the whole site as disallowed. That most likely caused the refusal.
- **The pages are empty without JavaScript.** The body is `<div id="root"></div>` (`createRoot` in `web-core/web/main.tsx:21`). AI agents, and every crawler that doesn't run JS, see nothing. There's no per-page `<title>` or description either.

We want:
- a real robots.txt that allows everything and points to the sitemap;
- a sitemap built from the site's real pages;
- page content readable without JS, **with no flash for visitors**.

## Approach

### 1. The content: a hidden semantic snapshot, never shown to a browser that runs JS

React's `createRoot` discards any DOM that is already in `#root`, so server-rendered content there would flash when React redraws. The snapshot therefore goes **beside** `#root`, not inside it:

```html
<head>… <style>html.js #equin-snapshot{display:none}</style>
        <script>document.documentElement.classList.add("js")</script> …</head>
<body><div id="root"></div>
      <div id="equin-snapshot"><h1>…</h1><p>…</p><a href="/website/vision">…</a>…</div>
```

- **Browsers:** the inline head script runs before the body is parsed, so the snapshot is never painted. React mounts in `#root` and never touches the snapshot. There is no swap, so there is no flash.
- **Non-JS readers:** curl, WebFetch, AI agents and Bing's first pass read plain markup. They get the page's text and links. A class plus stylesheet rule is used rather than `hidden` or `<noscript>` because Readability-style extractors drop `hidden` and inline `display:none` content and handle `<noscript>` inconsistently, but they don't evaluate stylesheet rules.
- **Googlebot** runs JS and indexes the real rendered page. The snapshot holds the same text, so it isn't cloaking.

The snapshot is **semantic, not a DOM dump.** Only `h1–h6, p, a[href], ul/ol/li, blockquote, pre/code, table, figure/figcaption, img[alt]` and `strong/em` are kept, with no classes or styles. `svg`, `canvas`, scripts and controls are dropped. Since it is never styled, it is small and clean, which suits agents.

The head also gets a per-page `<title>`, a `<meta name="description">` (the page's first paragraph, cut at about 160 characters) and `<link rel="canonical">`.

### 2. How the content is computed: crawl the real built site in headless Chromium

Rendering React on a server isn't possible here. The pages are full of canvas, SVG and animation, and live data comes from the plugin runtime; nothing in the repo uses `renderToString`. Instead, the real app renders each page and we read the result:

1. Start at the composition's home app (`/website`) and load the page in headless Chromium (reuse the `e2e-harness` browser lifecycle that `release/e2e/release-boot-verify.ts` uses).
2. Wait until the page has settled: fonts loaded, no loading-state markers from `primitives/loading`, and a settle window like boot-verify's. The `no-networkidle` lint rules out waiting for network idle.
3. Serialize the semantic snapshot, `document.title` and the description.
4. Collect the same-origin links under the home app's base path and add them to the queue.
5. Repeat until the queue is empty.

The **page list is derived from the site's own links.** Nothing is hand-listed or declared. A new page linked from the nav appears in the snapshot and the sitemap with no code change. A crawl that yields an empty snapshot, or one still showing a loading state, **fails loudly**.

Output: `snapshot/manifest.json` (`{ pages: { "/website/foundations": { title, description, file } } }`) plus one HTML fragment per page.

### 3. When: at release time, written into the release's web dist

The website's content only changes when its code changes, so each release regenerates the snapshot and it can never go stale.

- **Where it hooks in:** in `./equin release`, after the hermetic build (`build --hermetic --composition website`), boot the staged bundle the way Preview does (`release/server/internal/preview-manager.ts`: the `launch` binary on a temp data dir and a free loopback port).
- **The crawl** runs against that bundle and writes `snapshot/` into the release's web dist. Then the release packs and ships as it does today.
- **Opt-in per composition:** a `crawlable: true` field on the `website` entry in `config/plugin-meta/composition/compositions.origin.jsonc`. Other compositions (desktop and so on) skip the step.
- **Running it by hand:** the crawl is also a standalone script, `./equin run plugins/release/plugins/snapshot/e2e/crawl.ts --url <deploy> --out <dir>`. It can be run against a worktree build for review.

### 4. Serving it: the gateway reads the manifest

The gateway already serves the shell and splices per-path head HTML from `document-head.json` (`gateway/document_head.go`: `matchDocumentHead`, `spliceHead`). It gets the same kind of splice for the snapshot:

- **A page path listed in `<web>/snapshot/manifest.json`** (exact match, trailing slash normalized): splice the head additions before `</head>`, then add `<div id="equin-snapshot">…</div>` after `<div id="root"></div>`. Use a strong ETag over the combined bytes, like document-head's.
- **`/robots.txt`** (`text/plain`):
  - With a manifest: `User-agent: *`, `Allow: /`, `Sitemap: <origin>/sitemap.xml`.
  - Without one: **404**. RFC 9309 reads a missing robots.txt as allow-all; an HTML page answering for it, as today, is wrong.
- **`/sitemap.xml`** (`application/xml`): one `<url><loc>` per manifest page, or 404 when there is no manifest.
- **Origin:** taken from the request (`Host` plus `X-Forwarded-Proto`, which Caddy sets), so any deployment's hostname is correct with no config. Today `equin.ai` appears nowhere in config; hostnames live per deployment in the DB.

Gateway serving is chosen over files in `web/public/` or a Caddy `respond` for two reasons:
- a static file can't know the origin;
- Caddy would put the site's content into deploy infrastructure.

The gateway is the layer that already owns serving the shell.

### Where the code lives

- **New plugin `plugins/release/plugins/snapshot`:**
  - `core/`: the manifest schema (zod), shared by the crawler and its test.
  - `e2e/crawl.ts`: the crawler.
  - `cli` hook: the release step.
  - The serializer lives with the crawler, with a unit test over a fixture DOM.
- **`gateway/`:** a new `snapshot.go` (manifest load, keyed per request by the dist path, like document-head) and the routing in `handleStatic`, with `snapshot_test.go` next to it.
- **The composition schema:** the `crawlable` field.

## Caveats

- **The local gateway** only picks up Go changes after `./equin start`, which you run, not me. The release bundle carries its own gateway, so end-to-end verification runs against a staged release (below).
- **On equin.ai** it takes effect at the next website release and ship.
- **Interactive pieces** (the hero film, the demo canvas, the iceberg drawing) contribute only their text and `alt`. That's intended.

## Verification

1. `./equin test plugins/release/plugins/snapshot` for the serializer and the manifest; `go test ./gateway/...` for the splice, robots, sitemap and 404s.
2. Run `crawl.ts` against my worktree build and read the manifest and fragments. Check that every nav page is there and has real text.
3. Stage a release with `./equin release --composition website --target web --dev`, run `<out>/launch`, then:
   - `curl /robots.txt` and `/sitemap.xml`: correct content types and absolute URLs.
   - `curl /website/foundations`: the snapshot and the title are in the HTML.
   - `curl /nope`: still the shell. A real 404 is out of scope.
4. **No flash:** with `release-boot-verify.ts` plus a screenshot at time 0 and after mount, the snapshot is never visible, and `getComputedStyle(#equin-snapshot).display === "none"` before React mounts.
