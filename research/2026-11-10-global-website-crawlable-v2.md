# Make the public website crawlable, v2: static render of the real components

Supersedes `2026-11-10-global-website-crawlable.md`, which crawled the built site in headless Chromium at release time. v2 keeps that plan's serving design (a hidden snapshot beside `#root`, robots.txt and sitemap.xml per request). It replaces how the content is computed.

## Context

https://equin.ai is a client-rendered SPA: the HTML body is `<div id="root"></div>`.
- AI agents and other non-JS crawlers read nothing.
- `/robots.txt` and `/sitemap.xml` (and every unknown path) answer 200 with the SPA shell (`gateway/proxy.go` `handleStatic`). A 5xx on robots.txt during a restart reads as "disallow all" under RFC 9309, which most likely caused another Claude session to refuse the site.

Goals:
- a real robots.txt and a sitemap built from the site's declared pages;
- each page's text readable without JS;
- **no flash for visitors**;
- **copy stays in the JSX where it is drawn**. No content-as-data indirection, and no scraping.

## Design

### 1. Pages are declared: `defineWebsitePage` (path, title, description)

`core/` of each page plugin declares only metadata:

```ts
export const downloadPage = defineWebsitePage({
  path: "/website/download",
  title: "Download",
  description: "One command to install equin, and what to do once it runs.",
});
```

- **Web:** `websitePane(downloadPage, DownloadBody)` builds the `Pane.define`. The route segment is derived from `page.path`, so it can't drift from the sitemap. The pane keeps `app: websiteApp` and `actions: WebsiteHeader`. Website panes move from `Pane.define` to `websitePane`.
- **Server:** each page plugin contributes `WebsitePages.Page(downloadPage)` to a collection owned by a new `apps/website/plugins/crawlable` plugin. This means new `server/` barrels for the page plugins and the landing shell; each is one line.
- **Check:** every `websitePane` page is also contributed on the server, so a page can't be missing from the sitemap.

### 2. Static render: the real components → HTML, at build time, never hydrated

The snapshot is hidden and never touched by React, so it doesn't need to match the live render. That lets us use `react-dom/server`'s `renderToStaticMarkup` once per page, with no hydration and none of SSR's matching constraints.

**A generic static-render primitive, `primitives/static-render`.** `renderPaneStatic({ registry, pane, path })` returns the HTML. It provides:
- **the composition's web registry in scope** (the per-composition registry files from `tooling/codegen/composition-registries`), so `Website.Section.Render` and the other page slots render their contributions in their configured order;
- **a static pane context**, so `useOpenPane().link(guidePane)` renders as `href="/website/guide"` and `openPane(...)` throws if called during render;
- **the barrel-import loader** (`plugin-meta/barrel-import`: real React and react-dom, CSS imported as empty modules, a fake `window` without `document`) to load web modules in bun;
- **no effects.** `renderToStaticMarkup` runs no `useEffect` or `useLayoutEffect`, so imperative canvas and SVG code never runs.

**The semantic pass.** The rendered HTML goes through the same semantic filter as v1:
- keep `h1–h6, p, a[href], ul/ol/li, blockquote, pre/code, table, figure/figcaption, img[alt], strong/em`;
- drop classes, styles, `svg`, `canvas` and controls.

The result is small and agent-friendly. Visual-only markup doesn't matter, because the snapshot is never shown.

**Canvas pages render a text alternative in their own component.** The Foundations iceberg and the Vision zoom draw their words imperatively from effects, so a static render (and a screen reader) gets nothing from them. Each component renders the words it already holds (`foundations/web/internal/iceberg/data.ts`, `vision/web/internal/chapters/*.ts`) as a visually hidden `<section>` next to its canvas, using the existing visually-hidden utility (look for an `sr-only` primitive first). This is an accessibility fix in the component, not a second copy of the content.

**When: at `./equin build`, in `buildAndPublishWebDist`.**
- The step runs in `plugins/framework/plugins/cli/plugins/build/cli/internal/app-artifacts.ts`, next to the `.build-graph` and `.build-id` writes (around line 1310), on the staging dist.
- It runs for every producer (served and hermetic), unlike the experimental stamp, so release bundles carry it.
- It writes `<dist>/snapshot/manifest.json` (`{ pages: { [path]: { title, description, file } } }`) plus one HTML fragment per page.
- It runs only for compositions whose registry contains `WebsitePages.Page` contributions.
- Cost: loading the website's web closure takes seconds; rendering takes milliseconds per page.
- **Fails loudly:** a component that throws during render, or a page whose snapshot has no text, fails the build and names the page and the component.

The step's code lives in the `crawlable` plugin as a build contribution. The build calls it through a generic hook (look for an existing build-step contribution point first), so the build doesn't name the website.

### 3. Serving

- **Gateway (`gateway/snapshot.go`, alongside `document_head.go`):** when `<web>/snapshot/manifest.json` lists the exact request path (trailing slash normalized), the gateway serves the shell with:
  - head additions: `<title>`, `<meta name="description">`, `<link rel="canonical">` (origin from `Host` plus `X-Forwarded-Proto`), and `<style>html.js #equin-snapshot{display:none}</style><script>document.documentElement.classList.add("js")</script>`;
  - `<div id="equin-snapshot">…</div>` inserted after `<div id="root"></div>`;
  - a strong ETag over the combined bytes, like document-head's.

  Browsers run the head script before the body is parsed, so the snapshot is never painted and **never flashes**. Text extractors read it as plain markup. A stylesheet rule is used rather than `hidden` or `<noscript>`, because Readability-style extractors drop those.
- **`/robots.txt` and `/sitemap.xml`:** the gateway forwards these two paths to the backend, in addition to `/api/` and `/ws/`. The `crawlable` server plugin answers per request from the `WebsitePages.Page` collection and the request's host:
  - robots.txt: `User-agent: *`, `Allow: /`, `Sitemap: <origin>/sitemap.xml`;
  - sitemap.xml: one `<url><loc>` per page.

  Both are public endpoints (`access: { public: "…" }`). A composition with no declared pages answers **404**, which reads as allow-all.

## Steps

0. **Spike (go/no-go): statically render the Download page.**
   - Write a throwaway `./equin run` script: barrel-import the website composition's web registry, render `downloadPane`'s component under a minimal registry scope and static pane context, and print the HTML.
   - Record every blocker: hooks needing context, `useSyncExternalStore` without a server snapshot, module-load browser globals, CSS-in-JS.
   - Then render the landing page and Foundations to size the rest.
   - **Report the findings to the user before step 1.** If the blockers are deep (the web runtime can't load in bun), stop and re-plan.
1. **The static-render primitive:** registry scope, static pane context, the semantic filter. Fix each building block that throws during a static render in that building block (e.g. give its `useSyncExternalStore` a `getServerSnapshot`), never with a website-side workaround.
2. **The `crawlable` plugin:**
   - `core`: `defineWebsitePage` and the manifest schema;
   - `web`: `websitePane`;
   - `server`: the `WebsitePages.Page` collection, robots.txt and sitemap.xml;
   - the build step;
   - the check (pane ⇔ server contribution).
3. **Migrate the website pages** (landing, apps, vision, foundations, story, guide, download) to `defineWebsitePage` and `websitePane`, and add their server contributions.
4. **Text alternatives** in the iceberg and the vision zoom.
5. **Gateway:** the snapshot insertion and forwarding the two root paths, with `go test`.

## Verification

- **Unit tests:** `./equin test` on the semantic filter, the manifest, robots.txt and sitemap.xml rendering, and the static pane context's hrefs. `go test ./gateway/...` for the insertion, the ETag, forwarding, and 404s without a manifest.
- **On my worktree build:** `./equin build`, then read `<dist>/snapshot/` (every page present, real text, iceberg and vision text included). Then:
  - `curl http://<worktree>.localhost:9000/robots.txt`, `/sitemap.xml` and `/website/foundations`.
  - **Caveat:** the local gateway only picks up Go changes after `./equin start`, which you run. Until then, verify end to end on a staged release: `./equin release --composition website --target web --dev`, then `<out>/launch` and curl `localhost:9100`. A release bundle carries its own gateway.
- **No flash:** `release-boot-verify.ts` passes. A screenshot taken at first paint and after mount never shows the snapshot. `getComputedStyle(#equin-snapshot).display === "none"` before React mounts.
- **An agent's view:** fetch `/website/foundations` with a plain HTTP client and confirm the page's text is readable.

## Out of scope

- Real 404s for unknown paths.
- Hydration / SSR first paint for visitors. The static-render harness is the first brick of that, if we ever want it.
- `llms.txt`.
