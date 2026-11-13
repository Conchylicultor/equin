# Load model: what loads, how and when — today and from scratch

Status: design proposal (research only — no code changed). M1 measurements in §12 (2026-11-13) contradict several sizing assumptions — read it first. Prompted by the equin.ai first-visit audit
(deploy `dpl-1785501087837-xkt5u5`): ~5 s on emulated fast 4G + 4× CPU, 6.7 s in the field.
Builds on [client lazy plugins](./2026-10-11-global-client-lazy-plugins.md) (its Phase 2 "load when
needed" rule and its sizing), [eager tier from markers](./2026-07-02-global-eager-tier-derived-from-markers.md),
[boot waiting state](./2026-10-12-global-boot-waiting-state.md),
[first-paint flash on the website](./2026-10-27-global-first-paint-flash-website.md) and
[website crawlable v3](./2026-11-10-global-website-crawlable-v3.md) (the static renderer).

Contents: 0 Context · 1 Current model · 2 Today's observed paint behaviour · 3 Prior art ·
4 Target model (with code) · 5 First paint: the smoothness contract, pre-render vs atomic ·
6 Tradeoffs, gains, risks · 7 Background effects and prefetch · 8 Edge cases · 9 Migration path ·
10 Open questions · 11 Verification · 12 M1 results.

## 0. Context

The user's requirements:

1. **Smooth like any modern website — not more, not less.** The first paint already wears the right
   theme (background, colours, fonts). No themeless text that later changes colour, no background that
   appears afterwards, no big layout jumps. Progressive rendering is fine; flashing and shifting are not.
   (Clarified after the first version of this doc, which over-read the requirement as "never paint
   until everything is ready".)
2. **Laziness is automatic.** Code loads when it is needed; the abstractions make that happen without a
   plugin author (usually an agent) thinking about it — so nobody can make something eager by accident.
3. Know what Notion, Linear, Figma, Next.js, Remix, Qwik, Astro, Facebook and VS Code do, and take
   what maps onto a slot/plugin architecture.

Audit numbers reused here (not re-measured):

| Cost | Size | Note |
|---|---|---|
| Eager tier | 612 modules, 1.93 MB br (6.9 MB raw) | all `modulepreload`ed before boot |
| — data-view + fields | ~280 KB | |
| — zod | 87 KB | |
| — reporters → page editor (Lexical/yjs) | not split out | via `reports.collab-hydration` and similar |
| Active-app ("priority") batch | 33 artifacts, 679 KB | includes base64 images of off-screen pages |
| Boot snapshot | 102 KB br | mostly icon sprites; serial, after eager eval |
| HTML | 343 KB raw | 1,533-entry import map, theme CSS twice, 612 preload tags, hidden `#equin-snapshot` |

---

## 1. Current model

### 1.1 The pieces

| Piece | Where | What it does |
|---|---|---|
| Shell HTML | `web-core/web/index.html` | Inline scripts (dark `data-color-scheme` floor, React commit bridge, boot-failure screen), `<div id="root">`, `<script type=module src=/main.tsx>` |
| Compose | `web-artifacts/core/internal/compose.ts` `composeDist` (≈l.199–330) | Injects build globals, **one inline import map covering every artifact**, the global stylesheet `<link>`, and `<link rel=modulepreload>` for `computePreloadClosure(seeds = entry + registry + every non-deferred web target)` |
| Head fragments | `shell/document-head` → `gateway/document_head.go` | The backend writes `document-head.json` per **app path**; the gateway splices the longest-matching entry before `</head>`: the theme CSS (`theme-engine/server/internal/theme-head.ts`), the app manifest, the demo's prestart script (`apps/demo/shell/server/internal/prestart-head.ts`). A file, so a page load never waits for a backend |
| Crawlable snapshot | `gateway/snapshot.go` + `primitives/dom/static-render` | For `crawlable` compositions: a React `renderToStaticMarkup` of each page in Bun, filtered to semantic HTML, spliced after `#root` and hidden by `html.js #equin-snapshot{display:none}` |
| Registry | `web-sdk/core/web.generated.ts` | `webEntries: { pluginPath, id, loader: () => import("@plugins/…/web"), dependsOn }[]` — one entry = one whole plugin barrel |
| Tier split | `codegen/core/eager-tier-gen.ts` → `web-sdk/core/web-tiers.generated.ts` | `DEFERRED_PLUGIN_PATHS` (197 today). Eager iff (1) **structural** — not `apps/plugins/<app>/plugins/<child≠shell>`; (2) calls a watched slot (`Core.Root`, `Core.Boot`, `Apps.App`, `ActionBar.Item`, `eager-tier.scan.ts`); (3) owns a `preload:` descriptor; (4) `dependsOn` closure of these |
| Boot | `web-core/web/App.tsx` `PageApp` effect (l.380–475) | See the waterfall |
| Boot snapshot | `network/live/plugins/boot-snapshot` | `Core.Boot({ label: "Boot snapshot", ifUnavailable: "block" })`: `GET /api/resources/boot-snapshot` → `hydrateResource` every preloaded key (config docs, resident icon sprites, …) |
| Lazy pieces that exist | `primitives/lazy-component` (`lazyComponent`, 11 importers: KaTeX, mermaid, maps, sonata notation…; `preload: "idle"`, `useLazyReady`), `createOnDemandPlugins` (App.tsx l.92, demo scopes), `layouts/route-fallback` | All opt-in; none is the default path |

### 1.2 The waterfall (website, cold, today)

```
t ──────────────────────────────────────────────────────────────────────────────────────▶
HTML 343 KB  ███▌ (gateway: static index.html + head fragment + #equin-snapshot spliced)
  │ parse head: importmap(1,533) · app.css (render-blocking) · 612 modulepreloads · theme CSS ×2
  ├─ modulepreload ×612 (1.93 MB br) ██████████████████████████                 ← network
  │                                   main.tsx eval → App mounts → BootScreen(loading-code)
  │                                   (themed canvas; "waiting" label fades in after 3 s)
  │                                   loadPlugins(eager): parse/compile/link 612 modules ████████ ← CPU
  │                                                       Core.Boot tasks start ─┐  (SERIAL #1)
  │                                                       GET boot-snapshot ─────███ 102 KB
  │                                                                hydrate → setState(ready)
  │                                                                first commit: website shell
  │                                                                (wordmark, GitHub link, empty body)
  │                                         resolveActiveAppPrefix(URL, Apps.App) ─┐ (SERIAL #2)
  │                                         import() priority batch: 33 artifacts ─████ 679 KB
  │                                                                       append → nav + sections
  │                                         rest of deferred tier, 24/batch, yieldToMain …
```

Order in code (`App.tsx`):

1. `ensureNotificationsClient(pageTransport).connect()` — WebSocket hoisted to t≈0 (l.387). Good.
2. `partitionWebEntries(webEntries)` → eager / deferred (l.391).
3. `await loadPlugins(eager)` (l.400). Bytes were preloaded, so this is mostly parse + compile + link
   + top-level eval — ~0.9 s for 821 plugins on main in the 10-11 profile.
4. `runBootTasks(bootTasksOf(eager))` (l.407): **only now** does the boot-snapshot GET start.
   *Serial #1*: the snapshot needs no eager code; it waits because a plugin contributes the task.
5. `setState({ phase: "ready" })` (l.454) → first app commit, with whatever the eager tier draws.
6. `resolveActiveAppPrefix` (l.200–258) picks `apps/plugins/<app>/`; `await loadDeferredBatch(priority)`
   (l.457). *Serial #2*: these artifacts are not in the modulepreload set (compose seeds only
   non-deferred targets), so their download starts after 3–5. They are picked **by path prefix**, so
   every page of the site comes along — each page plugin contributes a header nav item
   (`pages/*/web/index.ts`: `WebsiteHeader({ id: "story", component: StoryNavItem })`), and with it its
   whole page and base64 images.
7. Drain every remaining deferred plugin, 24 at a time (l.458). The end state is "the whole composition
   is loaded": laziness is only a reordering.

### 1.3 Where "eager" is decided by structure, not need

- **Rule 1 is a path rule.** Every non-app plugin (fields, page, conversations, debug …) is eager in any
  composition that contains it, whether or not the route reads it — why data-view/fields and zod ship
  eagerly on the website.
- **Watched slots pin whole plugins.** 60 plugin dirs contribute `Core.Root` (25 of them under
  `reports/`); each is eager with its whole import closure. `reports/collab-hydration/web/index.ts`
  mounts `CollabHydrationCollector`, whose imports reach the page editor → Lexical/yjs on a site with no
  editor.
- **The unit of loading is the plugin barrel.** `website/shell/web/index.ts` re-exports `WebsiteBand`,
  `WebsiteHero`, … *and* lists its contributions. Importing one helper evaluates the whole barrel and
  every component its contributions reference. The 10-11 sizing: "a single seed often closes over
  ~190 plugins".
- **Contributions hold components by value** (`Apps.App({ app, component: WebsiteLayout })`), so
  "registered" = "loaded": a slot cannot list an item without its implementation.
- **The deferred tier always fully drains.**

### 1.4 Where order is serial without needing to be

| # | Waits on | Needed? | Fix direction |
|---|---|---|---|
| S1 | boot-snapshot GET waits for eager eval | No — the URL is known at HTML time | start at t0 |
| S2 | the route's pane code waits for eager eval + snapshot + first commit | No — the gateway already matches app paths per request | preload in HTML |
| S3 | snapshot hydrate → first commit → *then* the app's batch | No | same |
| S4 | icon sprites inside the (no-cache, per-boot) snapshot | No — icon names are static `symbol("…")` data | cacheable asset |
| S5 | 612 preloads compete with the route's own needs | Over-fetch — "if too many resources are prioritized, effectively none of them are" (web.dev) | route-scoped preloads |

### 1.5 Website vs main app

| | Website (equin.ai) | Main app (agent manager) |
|---|---|---|
| Cache | mostly **cold** | mostly **warm**: `/artifacts/*` are `immutable` (`gateway/proxy.go:176`) |
| Dominant cost | bytes + parse, then two serial waits | eval of a large eager set + boot snapshot latency + the post-first-data render burst (10-11 findings) |
| Data | config, theme, icons — static-ish | live collections over the WS |
| Crawl | hidden static snapshot | n/a |

---

## 2. Today's observed paint behaviour (measured 2026-11-12)

Probe: a scratch Playwright script (CDP screencast + a `requestAnimationFrame` sampler injected before
the page loads, recording `html`/`body` background, text colour, font, `#root` contents, boot state,
`document.fonts.status`; cache disabled). One run each — indicative, not a benchmark.

### equin.ai `/` — fast-4G-like (9 Mbps / 60 ms) + 4× CPU, cold

| t (ms) | What is on screen |
|---|---|
| 1,120 | first paint: **themed dark canvas** (`body` `oklch(0.14 0.012 266)`, Inter, from the server head) |
| ~4,500 | boot screen's "waiting" label mounted (faded in after the 3 s grace; barely visible in frames) |
| 6,700 | first app commit: wordmark + GitHub icon + footer rule, **empty body, no nav** |
| 7,420 | nav items, Wish button, hero heading and text appear (FCP 7,408 — the boot label is too faint to count) |
| 8,670 | LCP; the hero video poster pops into the already-sized black box ~0.5–1 s after the text |

CLS 0.046. **No theme flash**: background, text colour and font are constant from the first frame
(the server-rendered theme CSS works). **But two progressive steps a modern site would not show**:
a ~0.7 s chrome-only frame (the header without its nav — nav items come from the deferred page
plugins), and a poster that pops in. The hidden `#equin-snapshot` never painted.

### Main app `/agents` — localhost, no throttling, cache disabled (host under normal fleet load)

| t (ms) | What is on screen |
|---|---|
| 212 | themed canvas |
| 600–4,200 | boot screen: **"Waiting for the server… Boot snapshot · 0:0N"** (first run: 6 s) |
| 4,375 | sidebar chrome only (Tasks, More, Queue), empty main |
| 5,060 | queue rows appear with **long titles** |
| 5,410 | titles **swap to short titles**, status icons appear (task-title read lands after first data) |
| 5,925 | main pane ("Good evening" + composer) appears and a **"New conversation" row is inserted at the top of the sidebar, pushing everything down 32 px** |

CLS 0.128 (above the 0.1 "good" threshold). Theme constant; the problems are **text mutation and
layout shift**, plus the boot snapshot as the long pole (seconds, server-side — a separate perf
investigation; this doc only removes its serial position).

So against the clarified bar: theme-before-paint is already met on both surfaces; the misses are
(a) partial-chrome frames, (b) late items inserted into drawn slots (CLS), (c) data that re-renders
visible text after first paint, and (d) plain time-to-content.

---

## 3. Prior art

Claims marked *(unverified)* could only be confirmed from snippets or secondary sources.

| System | First paint w/o flicker | Theme before paint | Code splitting | Lazy activation | Code + data in parallel |
|---|---|---|---|---|---|
| **Facebook 2020** ([eng blog](https://engineering.fb.com/2020/05/08/web/facebook-redesign/)) | 3 code tiers: T1 layout + skeletons, T2 everything for above-the-fold — *"after Tier 2, nothing on the screen should still be visually changing"*, T3 after display (logging, subscriptions) | CSS variables under theme classes in one atomic stylesheet | `importForDisplay` / `importForAfterDisplay` | **Data-driven deps**: Relay `@module` loads the renderer for the data type returned | **EntryPoints**: a route declares code *and* query statically; the server starts the query on the request; one round trip; prefetch on hover, fetch on mousedown; `@defer`/`@stream` |
| **VS Code** ([activation events](https://code.visualstudio.com/api/references/activation-events)) | Workbench renders contributed UI from manifests | n/a | One bundle per extension | `contributes` is static metadata; code activates on an event (`onCommand`, `onView`, `onLanguage`…); since 1.74 **inferred from contributions**; `*` discouraged; `onStartupFinished` after startup | n/a |
| **Next.js App Router** ([loading.js](https://nextjs.org/docs/app/api-reference/file-conventions/loading), [linking](https://nextjs.org/docs/app/getting-started/linking-and-navigating)) | Server Components + streamed HTML; `loading.js` = Suspense per segment; navigation in a transition keeps the old screen | `next-themes` inline script sets the `<html>` attribute before body parse | Per route segment *(unverified from fetched docs)* | Selective hydration: what the user interacts with first | Prefetch on viewport/hover |
| **React Router v7 / Remix** ([code-splitting](https://reactrouter.com/explanation/code-splitting)) | SSR; `HydrateFallback` | — | **Route modules are entry points**: "knows just from a URL which bundles are needed" | client loaders split into own chunks, run while component code downloads | parallel route loaders *(details unverified)* |
| **Qwik** ([resumable](https://qwik.dev/docs/concepts/resumable/), [1.14](https://qwik.dev/blog/qwik-1-14-preloader/)) | SSR, **no hydration**: listeners serialized into HTML | — | Per symbol | Handler code loads on first event | Bundle graph with probabilities → `modulepreload` (moved off a service worker in 1.14) |
| **Astro islands** ([docs](https://docs.astro.build/en/concepts/islands/)) | Static HTML, zero JS by default | — | Per island | `client:load / idle / visible` | Server islands deferred |
| **Notion** ([WASM SQLite](https://www.notion.com/blog/how-we-sped-up-notion-in-the-browser-with-wasm-sqlite)) | *(app shell details unverified)*; marketing site is a conventional pre-rendered site *(not verified per page)* | — | core first, rest deferred *(snippet)* | WASM SQLite loaded **async, off the critical path** | Navigation races local SQLite vs network (+20 % nav speed) |
| **Linear** *(secondary sources only)* | Local-first; UI reads IndexedDB | — | — | Heavy data deferred during bootstrap | Delta sync |
| **Figma** ([3×](https://www.figma.com/blog/webassembly-cut-figmas-load-time-by-3x/)) | Canvas app | — | — | — | *(not documented)* |

Web platform: CSS is render-blocking by default ([web.dev](https://web.dev/articles/critical-rendering-path/render-blocking-css));
preload few, high-value resources ([web.dev](https://web.dev/articles/preload-critical-assets)); a
huge import map sits on the critical path ([Shopify](https://shopify.engineering/resilient-import-maps));
React 19 `hydrateRoot` replays discrete events (clicks) that land on not-yet-hydrated Suspense
boundaries once they hydrate.

**What maps onto equin:**
1. **VS Code's manifest/activation split** — a plugin barrel is already enforced *pure*: it is a
   manifest that happens to hold component values. Make the impls lazy references; infer activation
   from where they are drawn.
2. **Facebook's EntryPoints and 3 tiers** — *route → required set* (code + data, started on the
   request) and the paint contract ("nothing visually changing after display").
3. **React Router's "URL → bundles"** — the gateway already matches the URL per request.
4. **Next's transitions** — navigation keeps the old screen until the new one is ready.
5. **Marketing-site pre-render (Next/Astro)** — for the public website only (§5).

---

## 4. Target model (with code)

### 4.1 In one paragraph

**A plugin is a manifest plus lazily referenced implementations.** The manifest (ids, titles, icons,
routes, slot memberships, ordering keys, small sync predicates) is always loaded; implementations
(components, handlers) sit behind references the build creates and load when **drawn**, **routed**
or **invoked**. The build computes, per `(composition, route)`, the **required set** — modules, live
keys, theme scope, fonts — and the gateway sends it with the HTML so code and data download in
parallel from t0. The first paint is complete and themed (pre-rendered HTML on the website; one
atomic commit in the app); nothing loads "because it is in the composition".

```
request /about/foundations
  gateway: match route in dist/route-sets.json
  ├─ head: inline theme CSS (route scope) · font preloads · modulepreload × route modules (~tens)
  │        · preload fetch(route data)
  └─ body: website → pre-rendered page HTML in #root;  app → empty #root
browser, in parallel from t0: route modules ████  route data ███  manifests ██
  website: paints at HTML+CSS; hydrates when modules land (clicks replayed)
  app:     themed canvas → ONE commit of chrome + content when modules + data are in
  idle:    prefetch (fetch, not eval) the sets of links in view / on hover
  later:   drawn / invoked impls load inside transitions (old UI stays)
```

### 4.2 A plugin barrel: today vs after the build transform

**Authored (unchanged — this is today's `apps/plugins/website/plugins/shell/web/index.ts`, trimmed):**

```ts
import { Apps } from "@plugins/apps-core/web";
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { WebsiteLayout } from "./components/website-layout";
import { WebsiteWordmark } from "./components/website-wordmark";
import { WebsiteHeader } from "./slots";
import { landingPane } from "./panes";
export { WebsiteBand } from "./components/website-band";      // for other plugins

export default {
  contributions: [
    Apps.App({ app: websiteApp, component: WebsiteLayout }),
    WebsiteHeader({ id: "wordmark", component: WebsiteWordmark }),
    Pane.Register({ pane: landingPane }),
    ThemeEngine.Theme(equinTheme),
  ],
} satisfies PluginDefinition;
```

**Emitted runtime module (what the browser loads as the plugin's manifest):**

```ts
import { lazyRef } from "@plugins/framework/plugins/web-sdk/core";
import { Apps } from "@plugins/apps-core/web";               // slot factories: manifest-level only
import { Pane } from "@plugins/primitives/plugins/pane/web";
import { WebsiteHeader } from "./slots.js";                    // slot declarations: tiny
import { landingPane } from "./panes.js";                      // itself transformed (below)
// Every `component:` value in a slot payload became a reference — the module is NOT imported:
const WebsiteLayout   = lazyRef(() => import("./components/website-layout.js"),   "WebsiteLayout");
const WebsiteWordmark = lazyRef(() => import("./components/website-wordmark.js"), "WebsiteWordmark");
// Cross-plugin re-exports are gone from the runtime barrel (consumers import the defining module, §4.5).
export default { contributions: [
  Apps.App({ app: websiteApp, component: WebsiteLayout }),
  WebsiteHeader({ id: "wordmark", component: WebsiteWordmark }),
  Pane.Register({ pane: landingPane }),
  ThemeEngine.Theme(equinTheme),                               // data: stays as is
] };
```

`panes.tsx` goes through the same rewrite: the transform targets **slot-payload factory calls**
(`X.Y({...})`, `Pane.define({...})` — the marker calls `eager-tier.scan.ts` already finds with
`findMarkerCalls`), in any module under `web/`, and rewrites `component: <imported identifier>`.
A component *defined in the same module* (today's `LandingBody` inside `panes.tsx`) cannot be split;
the `lazy-contributions:component-in-own-module` check fails the build with "move `LandingBody` to its
own module" (rung 3) — so there is no eager spelling left.

**The manifest record the build sees** (from `plugin-meta/plugin-records/evaluate`, which already
serializes "what importing a barrel produced"):

```jsonc
{ "plugin": "apps.website.shell",
  "contributions": [
    { "slot": "apps-core.App", "data": { "app": { "id": "website", "basePath": "/about" } },
      "refs": { "component": "apps/plugins/website/plugins/shell/web/components/website-layout#WebsiteLayout" } },
    { "slot": "apps.website.shell.header", "data": { "id": "wordmark" },
      "refs": { "component": "…/components/website-wordmark#WebsiteWordmark" } },
    { "slot": "primitives.pane.Register", "data": { "pane": { "route": "website-landing", "appIndex": true } },
      "refs": { "pane.component": "…/web/landing-body#LandingBody" } } ] }
```

**Field kinds are declared by the slot, not guessed** (rung 2). A slot payload type marks which
fields are lazy and which must stay synchronous:

```ts
// web-sdk/core
type Lazy<T> = T & { readonly [LAZY]: true };          // component or async handler, loaded on use
// A payload field is one of: data (string, IconRef…), a sync predicate (stays in the manifest),
// a component (always Lazy), or a handler `(…) => void | Promise<void>` (Lazy unless marked sync).
export const CommandPalette = { Item: defineSlot<{
  id: string; label: string; keywords?: string[]; icon?: IconRef;   // manifest
  onSelect: () => void;                                              // handler → lazy by default
}>() };
```

### 4.3 A slot host rendering lazy items

```tsx
// slot-render (sketch) — every <Slot.Render/> and renderAsContribution goes through this
function RenderSlot({ slot }: { slot: RenderSlot<any> }) {
  const items = useSlotOrder(slot);              // manifests only: ids, order, hidden — synchronous
  return (
    <SlotSuspense slot={slot}>                   // ONE boundary per host, not per item:
      {items.map((it) => (                       // a host's items appear together, never one by one
        <ContributionBoundary key={it.id} item={it}>   {/* existing per-item error isolation */}
          <LazyImpl ref={it.component} props={…} />    {/* React.lazy cached per ref */}
        </ContributionBoundary>
      ))}
    </SlotSuspense>
  );
}
```

What shows while an item loads, by when it loads:

| When | Behaviour |
|---|---|
| First paint, item in the route's required set | nothing suspends: the root awaits `loadAll(requiredRefs)` before the first commit (app) / before hydration (website) |
| Navigation (route change) | `navigate()` runs in `startTransition`; already-revealed boundaries keep the **old screen** until the new route's refs and data are in (React semantics) |
| An item drawn later, not predicted (a menu opened, a block type scrolled into view) | the host's fallback: by default `hold` = render nothing new *until the whole host is ready* (`useLazyReady` precedent), or the slot's declared `placeholder: { size }` so the box does not grow (no CLS). The `primitives/loading` spinner only after its existing ~120 ms delay |
| Chunk fails | `ContributionBoundary`'s error state: "Couldn't load — Reload to update" (§8 stale artifacts) |

### 4.4 Route → required set, and what the gateway splices

The build derives, never asks authors to list:

```
requiredSet(composition, route) =
    runtime (react, web-sdk, slot-render, pane router)
  ∪ manifests of every plugin in the composition          (small; measured in M1)
  ∪ refs of `Core.Root` items with activate: "boot"       (§7.1, budgeted)
  ∪ refs drawn on the route: app shell + matched panes + slot items the probe saw
  ∪ static module closure of all of the above             (module granularity, §4.5)
liveKeys(route)   = boot-preloaded keys ∪ keys the probe read before first commit ∪ pane.preload(params)
```

The **render probe** reuses the static renderer that already renders every crawlable page in Bun
(`primitives/dom/static-render`, `createStaticRenderer`): it records which lazy refs resolved and which
live keys were read. Static closure ∪ probe = the set; a ref the probe needed but the static rule
missed is printed as a modeling gap.

Generated `dist/route-sets.json`:

```jsonc
{ "routes": {
  "/about": {                                  // website landing (pane website-landing)
    "modules": ["/artifacts/react-dom.ab12.js", "/artifacts/apps.website.shell/website-layout.9f.js",
                "/artifacts/apps.website.landing.hero/hero.3c.js", "…"],          // ~40
    "data": "/api/resources/boot-snapshot?route=website-landing",
    "themeScope": "app:website", "fonts": ["/artifacts/fonts/inter-var.7d.woff2"],
    "prerender": "/prerender/about.html",
    "bytes": { "js": 181000, "css": 21000 } },
  "/agents/c/:id": { "modules": ["…"], "data": "/api/resources/boot-snapshot?route=conversation&id={id}", "…": "…" } } }
```

What the gateway sends for `GET /about` (extending `document_head.go`'s per-app-path splice — the
same mechanism the demo's prestart script already uses to start work at t0):

```html
<head>
  <style data-theme="app:website">:root{--background:oklch(.14 .012 266);…}</style>   <!-- once, route scope -->
  <link rel="preload" as="font" type="font/woff2" crossorigin href="/artifacts/fonts/inter-var.7d.woff2">
  <link rel="preload" as="fetch" crossorigin href="/api/resources/boot-snapshot?route=website-landing">
  <link rel="modulepreload" href="/artifacts/react-dom.ab12.js">
  …                                                          <!-- ~40, not 612 -->
  <script type="module" src="/artifacts/entry.e1.js"></script>
</head>
<body><div id="root"><!-- website: pre-rendered landing page HTML --></div></body>
```

Data: the boot task consumes the preloaded response instead of issuing its own GET (S1 gone). Icon
sprites leave the snapshot: the sprite for the icons the route's modules name is a content-addressed
`/artifacts/sprites/<hash>.svg` in `modules` (S4 gone). A parameterized pane declares its data entry
point (Facebook EntryPoint):

```ts
export const conversationPane = Pane.define({
  route: defineRoute({ id: "conversation", segment: "c/:id" }),
  preload: ({ id }) => [conversationLive.key({ id }), transcriptHead.key({ id })],  // data only
  component: ConversationView,                                                      // → lazy ref
});
```

### 4.5 Cross-plugin import: before and after

```ts
// authored in apps/plugins/website/plugins/pages/plugins/vision/web/…  (unchanged)
import { WebsiteBand } from "@plugins/apps/plugins/website/plugins/shell/web";
```

| | Emitted specifier | What the browser evaluates |
|---|---|---|
| Today | `@plugins/apps/plugins/website/plugins/shell/web` → import map → the shell artifact's `index.js` | the whole shell barrel: every re-export, every contribution, `WebsiteLayout`, the theme definitions… |
| Target | `@plugins/apps/plugins/website/plugins/shell/web#website-band` → `/artifacts/…/website-band.4a.js` | `website-band` and its own imports only |

Exact because barrels are pure re-exports (enforced): the compose step reads each barrel's
`export { X } from "./y"` table and rewrites the importer's specifier. tsc and the boundary rules
still see `@plugins/…/web` — authors write the same thing. This is what removes the ~190-plugin
fan-out per seed. *(Hypothesis to verify in M1: web-artifacts' per-plugin lib build can keep module
boundaries — `preserveModules`-style output — rather than one `index.js` per plugin.)*

### 4.6 The `load-budget` check

```jsonc
// config/plugin-meta/composition/budgets.jsonc  (per composition; sizes brotli)
{
  "website": {
    "routes": {
      "*":            { "js": "220 KB", "css": "30 KB", "modulepreloads": 60, "html": "40 KB", "data": "20 KB" },
      "/about/apps":  { "js": "300 KB" }                     // a heavier page, stated on purpose
    },
    "bootRoots":   { "js": "15 KB" },   // Core.Root activate:"boot" impls
    "manifests":   { "js": "60 KB" }    // every plugin's manifest module
  },
  "agent-manager": {
    "routes": { "*": { "js": "900 KB", "modulepreloads": 250 } },
    "bootRoots": { "js": "40 KB" }, "manifests": { "js": "150 KB" }
  }
}
```

Failure output names the overage and why (from `tooling/import-closure`'s chain):

```
load-budget: website /about — js 312 KB > 220 KB
  +118 KB primitives/data-view (via apps.website.landing.layers → LayersTable → DataView)
  + 87 KB zod                  (via config_v2/core → parsedJson)
```

Numbers above are placeholders until M1 measures the real sets.

### 4.7 Theme

Unchanged mechanism (already correct, §2): server-rendered CSS per app path, spliced by the gateway.
Changes: emit once (the audit found it twice); scope to the route (root + app scope + sub-themes the
route's modules reference); preload the fonts it names; the global `app.css` either inlined (if small)
or preloaded as part of the set. `ThemeInjector` starts from the server's answer (the 10-27 "held"
state stays).

---

## 5. First paint: the smoothness contract, pre-render vs atomic

### 5.1 The contract (the modern-site bar)

1. **Themed from frame 1** — background, colours and fonts from the server's inline CSS + preloaded
   fonts. Already met (§2).
2. **No partial chrome** — a frame never shows a host missing items it will gain a moment later
   (today's header without nav; today's sidebar without "New conversation").
3. **No visible re-render of the same content** — text does not change once shown (today's long → short
   task titles). A read whose answer changes what is shown is in the route's `liveKeys`.
4. **No big layout shift** — CLS < 0.1, target ~0; late media sits in a box sized up front.
5. **Progressive is allowed** — below-the-fold content, images and later surfaces may arrive later, in
   reserved space.

### 5.2 What the two strategies mean, plainly

- **Atomic first paint** — the browser shows only the themed background until the code and data for
  the visible screen are all in memory; then React draws the whole screen in one frame. Nothing
  appears until everything visible can appear, and what appears works immediately.
- **Pre-render + hydrate** — the server (or the build) sends the screen as finished HTML; the browser
  paints it as soon as the HTML and CSS arrive, like any static page; JavaScript then *hydrates*:
  attaches behaviour to the DOM that is already there, without redrawing it.

### 5.3 What would "break" on the website during the hydration window

Walking the landing page (§2 frames):

| Element | Before hydration | How others handle it |
|---|---|---|
| Header nav links (`WebsiteNavLink`), GitHub link, footer links | **Work** — real `<a href>`; a click does a full page load instead of a client navigation (static render already writes the real href) | same everywhere; acceptable |
| Text, headings, layout, hover styles | Fine (pure HTML/CSS) | — |
| Wish button (opens a popover) | Looks ready, does nothing yet | React 19 replays the click once that boundary hydrates — delayed, not lost; Next/Remix rely on this |
| Hero video play button (`MediaPlayer`) | Poster shows; click replayed after hydration | same; or a native `<video controls>` fallback |
| "Try it live" demo (browser-host worker) | Its entry button replayed; the demo itself is heavy and loads on demand anyway | islands (Astro) |
| Scroll-reveal / `useWebsiteSectionReach` animations | **Risk**: content hidden until JS would be a flash — pre-render must render the *revealed* state, or reveal via CSS-only | Astro/Next: CSS animations or no-JS-visible content |
| Anything reading viewport, storage, time during render | **Risk**: hydration mismatch → React re-renders the subtree (a visible change) | render a stable, sized placeholder; read in effects |

So the window is "looks ready, a few buttons answer late" — the standard marketing-site bar, *if* the
hydration JS is small (the window lasts as long as the route's JS takes; with today's 1.93 MB it would
be ~5 s, with a ~200 KB route set it is short).

Note the existing crawlable snapshot cannot be reused as-is: it is rendered in `renderMode("static")`
(writes "what a click would compute", e.g. collapsibles open, `data-link`) and filtered to semantic
HTML — it differs from the live render on purpose, so hydrating it would mismatch. The pre-render is a
second output of the same renderer in **live** mode, unfiltered, with `renderToString` (hydratable).

### 5.4 Recommendation per surface

- **Public website: pre-render + hydrate** (revised from v1). The content is static, enumerable
  (every page is a `defineWebsitePage`), already rendered by the real components in Bun, and the
  standard bar is met best by painting real content at HTML + CSS time (est. ~1–1.5 s on fast 4G vs
  7.4 s FCP measured). Conditions:
  1. Lands **after** route sets (M4): hydration JS must be the route set, not the composition.
  2. Pre-render in live mode, at build/deploy, per page; inline the route's CSS; one HTML per page.
  3. A **hydration check** (rung 3): an e2e pass hydrates every page with `onRecoverableError` →
     fail; plus the existing no-DOM-in-render rules from crawlable v3.
  4. Interactive widgets render their resting state; clicks are replayed (React 19). No
     JS-only-visible content.
  5. `#equin-snapshot` is dropped: the pre-rendered `#root` is itself the crawlable content.
- **Agent-manager app: atomic route paint, no SSR.** Data is private and live, the cache is warm, the
  server is the user's own busy machine (§2: the boot snapshot alone took seconds), and every surface
  is interactive — a pre-rendered-but-dead app is the worst case. Instead: themed canvas → one commit
  of chrome + route content + route data, then progressive below-the-fold only. This directly removes
  the §2 sidebar-then-rows-then-titles-then-row-insert sequence.
- **Not taken**: Qwik-style resumability (a compiler rewrite of every component); a service-worker
  app shell (a cache — the perf instruction says target the cold case).

---

## 6. Tradeoffs, gains, risks

### 6.1 What gets better

| Area | Today (measured / audit) | Target (estimate — verify per step) |
|---|---|---|
| Website FCP (fast 4G + 4× CPU) | 7.4 s FCP, 8.7 s LCP (§2); audit ~5 s | pre-render: ~HTML+CSS ≈ 1–1.5 s; interactive when route set lands |
| Website HTML | 343 KB raw | ~30–60 KB incl. pre-rendered page |
| Website eager JS | 1.93 MB br, 612 modules | route set ~200 KB br, ~40 modules (budget) |
| Serial waits | S1 (snapshot after eval), S2 (app batch after first commit) | none: code + data from t0 |
| Snapshot | 102 KB per boot, uncacheable | sprites cached immutable; snapshot = route data only |
| App eval on warm load | ~0.9 s for 821 plugins (10-11) | manifests + route impls only |
| App visual stability | CLS 0.128, title swap, row insert (§2) | one commit; CLS ~0 |
| Accidental eagerness | path rule + watched slots + barrel fan-out | no eager spelling; boot roots budgeted |

### 6.2 What gets worse or harder — ranked risks

| # | Risk | Severity | Mitigation |
|---|---|---|---|
| 1 | **Mispredicted required set** → an unplanned load at first paint (waterfall; in the app a held host, on the website a late hydration) | High | static closure ∪ render probe; runtime report when a first commit suspends (names the ref); `load-budget` keeps sets honest |
| 2 | **Stale artifacts mid-session** — more code loads later, so a deploy/prune between page load and a lazy load 404s more often | High | keep the previous builds' artifacts addressable for ≥ a session (content-addressed store retention; a release deploy keeps the prior release's `artifacts/`); chunk-load failure → error boundary "Update available — Reload" (`build/web/hooks/use-stale-frontend.ts` already detects a new graph); persisted state survives reload |
| 3 | **Slots that need item facts before code** (order, `when` filters, counts, shortcuts, palette search) | Med-High | field kinds declared on the slot (§4.2): ids/labels/keys/order/sync predicates are manifest; only components and handlers are lazy. Reorder config is keyed by contribution id, so order needs no code |
| 4 | **Hydration mismatch on the website** (visible re-render) | Medium | hydration e2e check; render-mode discipline; DOM-in-render lint (crawlable v3 step 1) |
| 5 | **Build complexity and time**: barrel transform, specifier rewrite, route sets, render probe, pre-render | Medium | transform and rewrite are per-module and content-addressed (cached like artifacts); the probe reuses the crawlable renderer and runs only for probed routes; route sets are plugin-records keyed on closures (recompute O(changes)) |
| 6 | **Warm app: more, smaller requests** | Low-Med | warm loads hit the HTTP/memory cache (immutable); on HTTP/1.1 (plain `http://*.localhost` — browsers only negotiate h2 over TLS; *gateway protocol not verified*) six connections per host make many tiny modules slow cold → compose can **coalesce a route set's small modules into a few files** (route chunks) without changing the model |
| 7 | **Debugging "why is X (not) loaded"** | Medium | `./equin load explain <composition> <route> [module]`: the set, each member's reason (manifest / boot root / drawn ref / probe / closure chain via `import-closure`); boot-trace already times each load |
| 8 | **Import map size**: a map must name everything reachable later, not just the route | Low-Med | release builds (the website) resolve specifiers to URLs at compose time → no map; dev keeps one map (localhost, cached HTML); per-route maps only if multiple-map merging is supported by target browsers *(unverified for Safari)* |
| 9 | **HMR / dev loop** | Low | there is no HMR today (`./equin build` per change); the transform is one more per-barrel pass |
| 10 | **React Compiler** | Low | it runs per file in the babel `vite/` contribution; manifests contain no components; `LazyImpl` wraps `React.lazy`, which the compiler treats as any component. **Hooks cannot be lazy** (called unconditionally during render): a hook-valued field (`Hook<F>` brand, `framework/hook-value`) is a manifest field by type, and a heavy one is moved behind a component |

---

## 7. Background effects and prefetch

### 7.1 Background effects — activation events

Today every `Core.Root` contributor (60 plugin dirs: reporters, shortcut manager, command palette
root, app-usage, toasts, theme engine, icon sprites, hints…) and every `defineMountSlot` effect
(menu-bar `Mount`, browser `Effects`, sonata session/player `Effect`) runs because its plugin is
eager. In the target, **a headless contribution must say when it activates** — a required field
(rung 2), VS Code style:

```ts
type Activation =
  | "boot"                                  // always, from t0 — budgeted (load-budget "bootRoots")
  | { onSink: ReportSink<unknown> }         // first emit into a report sink
  | { onEvent: DomEventName }               // first keydown / paste / visibilitychange …
  | { onSlotDrawn: AnySlot }                // when its host slot first renders
  | { onLive: LiveKey }                     // when this live key first changes
  | "afterPaint";                           // idle after the route is on screen (Tier 3)

Core.Root({ component: CollabHydrationCollector, scope: "page",
            activate: { onSink: collabHydrationReportSink } });   // loads only if the editor ever emits
Core.Root({ component: AppUsageRecorder, scope: "page", activate: "boot" });   // tiny, counted
Core.Root({ component: CommandPaletteRoot, scope: "page", activate: { onEvent: "keydown" } });
Core.Root({ component: MainThreadStallCollector, scope: "page", activate: "afterPaint" });
```

- **What is eager then**: the runtime, every plugin's manifest, and the impls of `activate: "boot"`
  roots — and those are a named budget line (`bootRoots`), so adding a heavy one fails the build with
  its import chain. An agent cannot write a root without choosing; the cheap correct choice is the
  default most will copy.
- **The trigger lives in the manifest, the reaction is lazy.** A report sink is a tiny `core` module
  (the producer imports it, the collector drains it); the first `emit` triggers the collector's import,
  and the sink buffers until it lands. The same for `onEvent` (one shared listener per event name in the
  runtime) and `onLive` (the live client already knows key changes).
- **Keyboard shortcuts**: `ShortcutManager` is `"boot"` (one listener, small). Each shortcut's
  `keys`/`when` are manifest; `run` is a lazy handler. Matching and `preventDefault()` happen
  synchronously from the manifest, then `run` executes once loaded (tens of ms; prefetched on hover of
  the UI that advertises it).
- **Live subscriptions / notification watchers**: the subscription is data (`onLive`), the toast impl
  loads on first change.
- **Mount slots** (`defineMountSlot`): their host decides when they mount (the sonata player mounts its
  effects when a song plays) → `onSlotDrawn` is implicit; no change for authors.

### 7.2 Prefetch — what exists today and where it goes

| Today | Where | What it does | In the target |
|---|---|---|---|
| `preload: "boot"` (53 files) / `"boot-and-keep"` (24) | `network/live` descriptors | data in the boot snapshot | unchanged, but the snapshot request starts at t0 and shrinks (sprites out); route data via `liveKeys` |
| Deferred tier drain | `App.tsx` l.458 | **evaluates** every remaining plugin after paint, 24/batch | replaced by **idle prefetch**: `fetch` (HTTP cache only, no eval) the route sets of links in the viewport and of the app's sibling routes, at idle, capped by a byte budget; nothing is evaluated until used |
| `lazyComponent({ preload: "idle" })` | `primitives/lazy-component` (`requestIdleCallback`) | loads a chunk at idle so a popover opens at full size | becomes a slot/contribution option `prefetch: "idle"`, same semantics, for hosts that must open at final size |
| Demo prestart head script | `apps/demo/shell/server/internal/prestart-head.ts` | starts the demo's worker at t0 on return visits | the precedent for §4.4's head splicing; stays |
| WebSocket hoist | `App.tsx` l.387 | socket opens at t0 | stays |
| `prewarm/` folders (website media, emoji, piano, soundfont) | `asset-mirror` prewarm seeds | **build/release-time** asset bundling on the server, not browser prefetch | unchanged (orthogonal) |
| `<link rel=prefetch>`, Speculation Rules, Service Worker | — | none found | hover/viewport prefetch of route sets (`<link rel=prefetch>` per route set; Speculation Rules `prefetch` for website links, *browser support Chromium-only*). **No Service Worker** — a cache that hides the cold path |

---

## 8. Edge cases

**Commands and keyboard shortcuts with lazy handlers.** Problem: a key must be matched and its default
prevented synchronously. Resolution: keys/`when` in the manifest; `run` lazy (§7.1). A handler that must
act within the same task (e.g. `clipboard` writes needing user activation) is declared `sync` on the
slot field and stays in the manifest — tsc makes the choice explicit.

**Command palette / search over contributions.** Problem: searching needs labels before code.
Resolution: `CommandPalette.Item` is already `{ id, label, keywords, icon, group, shortcut, onSelect }`
— all but `onSelect` are manifest data; selecting awaits the lazy `onSelect` (palette shows its row
pending, ≤ one chunk). The palette root itself activates `{ onEvent: "keydown" }` on ⌘K.

**Drag and drop between plugins.** Problem: a drop target registered by a plugin whose impl is not
loaded. Resolution: a target only exists while drawn (dnd-kit registers on mount), so it is loaded
when it can receive a drop. Cross-plugin "what does this payload become" adapters split as: `accepts(type)`
sync predicate (manifest), `onDrop` lazy handler (async is fine after the drop).

```ts
DragTargets.Adapter({ accepts: (t) => t === "task-ref", onDrop: attachTaskToPage /* → lazy */ })
```

**A contribution that changes layout once loaded (CLS).** Problem: a late item grows its host (§2's
"New conversation" row). Resolution: first paint loads every drawn item (required set); later loads
use the host's `hold` (render the host's new items together, once all are in) or the slot's declared
`placeholder: { size }`. A render-slot whose items vary in size and are loaded late is flagged by the
`reports/panel-overflow`-style runtime check for layout shift.

**Error boundaries when a chunk fails** (offline, or deploy changed mid-session). Problem: more lazy
loads → more late failures. Resolution: `ContributionBoundary` distinguishes `ChunkLoadError` →
"Couldn't load — Reload to update" (or "Offline — Retry"), files a report only when online; artifact
retention ≥ session lifetime (§6.2 #2); the stale-frontend detector offers a reload proactively.

**Slot ordering / reorder config.** Problem: order must be known before impls. Resolution: none
needed — order is the config layout keyed by contribution id (manifest), applied by
`reorder/slot-middleware` on manifests. Hidden items are never loaded at all (a win).

**Variant regions and theme-engine token groups.** Problem: which variant (e.g.
`ui/sidebar-framing`'s flush/floating/inset) a scope picks is a config value, unknown to the static
closure. Resolution: config docs are boot-preloaded data, so the render probe resolves the selected
variant per route; static fallback: a variant region's variants are small and may be declared
`prefetch: "with-host"`. Token groups and themes are **data contributions** (`ThemeEngine.Theme(...)`)
— manifest — and their CSS is rendered server-side, so theme-before-paint is unaffected.

**The demo's browser-host worker.** Problem: the website's live demo runs real server code in a
SharedWorker and its plugin scope loads on demand. Resolution: already the target model —
`createOnDemandPlugins` (App.tsx l.92) and the prestart head script. The demo's own route sets are
computed for its scenario's starting route and prefetched on hover of "Try it live".

**Desktop window mode.** Problem: several apps on screen; the restored window set lives in
sessionStorage (`apps-core/tabs`), which the server cannot see. Resolution: the server preloads the
URL's route (the focused window); other windows' sets are requested from an inline head script that
reads the persisted tab set (no app code needed) at t0; the first commit waits for the windows that are
on screen; minimized ones load when shown (`useResidentTabs` already decides residency).

**The menu-bar panel** (`/home/menu-bar`, opened by the native helper). Problem: must open instantly,
repeatedly. Resolution: it is a route like any other with its own small set and budget; the helper
keeps its window's document alive between openings (no reload), so only the first open pays.

**Exhibits** (`/debug/exhibit-stage/<group>/<name>`). Problem: parameterized route over ~hundreds of
components. Resolution: the exhibit registry is a collected dir whose entries are already loader thunks
→ lazy refs; the route set is the stage + the one exhibit's ref (a dispatch by key, Level 2 for free).

**Plugins needed on both server and web.** Problem: shared `core` code and server-only registries.
Resolution: route sets are web-only; `core` barrels get the same specifier elision; the server keeps its
own registry (its lazy loading is the separate [Lazy plugins] task); the manifest records come from the
same `plugin-records/evaluate` pass.

**Live resources whose descriptors must be registered before snapshot hydration.** Problem: today's
invariant "a boot-critical descriptor must sit in the eager web graph" (`boot-snapshot/CLAUDE.md`)
pins its plugin eager. Resolution: the build emits a key → descriptor-module map; `hydrateResource`
for a key whose descriptor is not loaded **stashes the raw value** and parses it when the descriptor
module registers (or loads that module, if the key is in the route's `liveKeys`). The invariant
becomes "the key is in the map" (generated, rung 1), and the eager pin disappears.

**The website's crawlable snapshot.** Problem: today a hidden, semantic-only duplicate of the page.
Resolution: with pre-render + hydrate the page HTML in `#root` *is* the crawlable content; drop the
hidden snapshot and its bytes. Pages without JS (crawlers, AI fetchers) get the full pre-render; the
`robots.txt`/`sitemap.xml` endpoints are unchanged.

---

## 9. Migration path

Each step ships alone, measured with `debug/profiling/cold-start` and the §2 paint probe (to be made a
real `e2e/` script). Wins are estimates from the audit and §2 — *hypotheses until measured*.

**Quick wins (no new abstraction):**

1. **Q1 — Boot snapshot at t0.** `<link rel=preload as=fetch>` via a head fragment; the boot task
   consumes it. Removes S1.
2. **Q2 — Preload the active app's batch in the HTML** (per-app-path head fragment, the prestart
   precedent). Removes S2/S3: 679 KB starts at t0. Likely the largest quick win on the website (~1 s+
   on fast 4G, est.), and it removes the chrome-without-nav frame.
3. **Q3 — Images out of JS** (emitted files, as the KaTeX-font fix did; sized boxes, `loading=lazy`).
4. **Q4 — Icon sprites out of the snapshot** into an immutable asset.
5. **Q5 — Theme CSS once.**
6. **Q6 — Cut reporters → page editor** (collab-hydration's collector behind a dynamic import, or
   `onSink` by hand until §7.1 lands). *Done (att-1794568075), structurally rather than per
   collector:* a browser collector of another plugin's sink is now a `ReportSinks.Collector`
   companion keyed by its producer in a new `plugin` key space (`reports/collectors`), so it ships
   only where its producer ships; `reporters` names `reports.collectors` instead of each collector,
   and `report-sink/collect-through-companion` refuses a cross-plugin `sink.register` in `web/`.
7. **Q7 — App CLS**: find why the queue's short titles land after first data (likely the
   `tasks/task-title` read not being boot-preloaded) and why the sidebar's "New conversation" row is
   drawn late (likely contributed by a deferred plugin) — *both causes are hypotheses from the §2
   frames, to confirm* — and remove the §2 title swap and the 32 px shift. (Point fixes; M3/M4 make the
   class impossible.)

**Structural steps:**

8. **M1 — Measure the target** in a branch build of the website: manifest bytes, route-set bytes,
   probe keys, and whether artifacts can keep module boundaries. Sets the budgets.
9. **M2 — Specifier elision** (cross-plugin imports → defining module). Biggest fan-out cut.
10. **M3 — Lazy contribution impls + activation events** (barrel/payload transform, `Lazy<>` field
    kinds, slot-render Suspense per host, `Core.Root` `activate` required, transitions for navigation).
11. **M4 — Route sets + gateway splicing** (static closure + render probe; delete `eager-tier-gen`,
    `web-tiers.generated.ts`, `resolveActiveAppPrefix`, the deferred batches, `DeferredRouteFallback`;
    idle/hover prefetch instead of the drain). App: atomic route commit.
12. **M5 — `load-budget` check** (can land right after M1 against today's sets to stop regressions).
13. **M6 — Import map**: none in release builds; route chunks if HTTP/1.1 request count shows up.
14. **M7 — Website pre-render + hydrate** (live-mode `renderToString` per page at release build,
    hydration check, drop `#equin-snapshot`).
15. **M8 — Pane data entry points** (`preload(params)`, pending-first-commit report) for parameterized
    app routes; lazy descriptor registration (§8).

## 10. Open questions / hypotheses

- Manifest size for all plugins (M1) — the model assumes "small enough to always load".
- Can web-artifacts' lib build keep module boundaries per plugin (M2)?
- Which function-valued payload fields are heavy (M1 trace via the existing `slot-read:` marks)?
- Gateway protocol (HTTP/1.1 vs h2) on localhost and on the deploy box.
- Multiple-import-map support in Safari; Speculation Rules support outside Chromium.
- Does the website have any per-visitor content that would make a build-time pre-render wrong
  (analytics are client-side; config/theme are build inputs)?

## 11. Verification (per step)

- `cold-start.ts` on the website composition and `/agents`, before/after: HTML bytes, preload count,
  route bytes, snapshot start time, first commit, route-content commit.
- The §2 paint probe as an `e2e/` script (screencast + rAF sampler, throttled): themed from frame 1,
  no chrome-only frame, no text mutation after first content, CLS < 0.05.
- Website after M7: every page hydrates with zero recoverable errors; a click on Wish / play during
  hydration is replayed.
- Field: the website's boot reports, p75 time to route content.

---

## 12. M1 results — the assumptions, measured (2026-11-13)

Measured on main's dist (`singularity/web`, 1,657 modulepreloads) and a website composition dist
built from `96800db2` (614 modulepreloads, 1.944 MB br eager, matching the audit). Scripts are
not committed (scratch: `dist_stats.py`, `preserve.ts`, `manifest.ts`, `coverage.ts`,
`graph.py`/`q3.py`); each number below says how it was obtained. Sizes are oxc-minified bytes as
the dists hold them; "br" is the store's precompressed `.br` unless marked *est.* (raw × the
dist's first-party br/raw ratio, 0.274 website / 0.278 main).

### 12.1 Q1 — module boundaries in the per-plugin build (M2)

**Today: not kept.** Each plugin barrel is one rolldown lib-mode bundle (`index.js`, plus a shared
chunk only for co-entries / dynamic imports): 1,786 of main's 1,827 mapped artifacts are a single
file. Main's eager set is 5,583 first-party source modules in 1,518 artifacts (median 2 modules,
p90 7, max 168 — `primitives/data-view`).

**But they can be, at no structural cost.** Rebuilding real targets with the builder's own config
plus `output.preserveModules: true, preserveModulesRoot: <plugin dir>` (rolldown via vite, `write:
false`): 62 sampled web targets (stride sample of the fleet, plus website-shell and data-view)
all built, **one source module per output file in every one**, original export names kept.
The barrel becomes a facade of `import { X as t } from "./web/components/x.js"` + its
`export default { contributions }` — exactly the `export { X } from "./y"` table §4.5's specifier
rewrite needs. Costs: raw bytes +8 % (median; no scope hoisting), and **per-file brotli +24 %
(median), +75 % for data-view (186 files)** — compressing modules one by one loses the
cross-module dictionary. So module-granularity delivery needs M6's route chunks (re-coalescing a
route's modules into a few files) for bytes, not only for request count.

### 12.2 Q2 — always-loaded manifests

Method: Bun.build of every web barrel's default export of the composition (902 website, 1,178
main — from each dist's registry artifact), npm external, with **every `.tsx` module under a
plugin replaced by lazy-ref stubs** (the §4.2 transform, approximated: all components move out;
nothing else does). Sizes are Bun-minified as one file, so per-module delivery would be larger (§12.1).

| | website | main |
|---|---|---|
| Manifest closure — modules | 4,651 | 5,866 |
| — first-party code | 1.59 MB raw / **449 KB br** (one file) | 2.02 MB raw / **563 KB br** |
| — npm it still imports (excl. react) | **432 KB br**: lexical + @lexical/* (~310 incl. overlap), zod 89, yjs 31, htmlparser2 28, drizzle-orm/pg-core 26, fast-xml-parser 25, dnd-kit 37, react-query 14, @tonejs/midi 9… | same set + more |
| Today's eager set (for comparison) | 2,088 modules; 1,305 KB br first-party + 639 KB br vendor | 5,583 modules; 3,389 + 961 KB br |
| Doc's placeholder budget | 60 KB | 150 KB |

**This contradicts the doc's central assumption ("manifests are small enough to always load").**
Stubbing components removes only ~1/3 of the code: the residue is `.ts` modules that barrels and
`.ts` slot payloads reach — 62 % "other plugin `.ts`" (stores, parsers, helpers, data), 13 %
runtime (framework, live, pane), 9 % icon-name tables (`icon-picker`'s classic symbol names 58 KB,
`saved-names` symbol-names.json 57 KB, agent-icons 21 KB), 9 % slot/route/live/config/endpoint
declarations (zod schemas: 368 manifest modules import zod), and **data contributions that hold
heavy values** — Lexical node classes (26 `.ts` modules importing `lexical`), yjs, the MusicXML/MIDI
parsers of sonata sources, `html-decode`'s htmlparser2, `rank`'s drizzle import. The module count
(4,651) is *higher* than today's whole website eager set (2,088): a manifest per plugin for the
whole composition is wider than today's eager tier, which is only one slice of it.

What M3 must add to get there: (a) non-component values in payloads (node classes, parsers,
schema-heavy descriptors) need the same lazy treatment as components, i.e. field kinds for
"heavy data"; (b) a `manifest` budget check from day one that names the import chain (the residue
is a long tail — no single plugin is above 82 KB raw); (c) icon-name tables out of the page.

### 12.3 Q3 — per-route required sets

Method (an empirical render probe): V8 precise coverage from navigation until the route's content
is visible (website: `h1` visible, 1.7–3.5 s; main: content + 3 s settle), functions with
count > 0 mapped through the artifacts' sourcemaps to source modules = **what ran**; then their
static module closure resolved two ways — **barrel** (today: an `@plugins/x/web` import evaluates
the whole barrel) and **M2** (a named import resolves through the barrel's re-export table to the
defining module; type-only imports skipped; dynamic imports cut). Inlined images
(`?inline` jpg/png) are counted apart.

| Route | Today loaded at that moment | Ran (modules) | Barrel closure | **M2 closure** |
|---|---|---|---|---|
| website `/about` | 646 files, 1,990 KB br fp + 639 vendor | 561 | 2,049 mod, 900 KB br *est.* + 553 vendor | **1,074 mod, 532 KB br *est.* + 337 vendor** |
| website `/about/apps`, `/foundations`, `/vision` | 646–649 files, same | 538–554 | 1,949 mod, 841 + 553 | 998 mod, 474 + 333 |
| website `/about/story` | 649 files | 543 | 2,002 mod, 918 + 553 | 1,045 mod, 547 + 333 |
| main `/agents` | 1,657 files, 3,390 KB br fp + 961 vendor | 915 | 3,142 mod, 1,316 + 799 | **2,092 mod, 1,076 + 707** |
| main `/pages` | 1,671 files | 944 | 3,203 mod, 1,339 + 799 | 2,129 mod, 1,096 + 717 |
| main `/settings` | 1,657 files | 803 | 3,072 mod, 1,287 + 799 | 1,991 mod, 1,025 + 707 |
| main `/home` | 1,657 files | 908 | 3,114 mod, 1,303 + 799 | 2,069 mod, 1,070 + 707 |

Plus, on every website route, **395 KB raw of base64 images** in the closure (`pages/apps/web/shots/*.jpg`,
686 KB on `/story`) — Q3 (images out of JS) is independent of the model and worth it alone.

Reading it:
- **M2 halves the website route set** (modules −48 %, first-party bytes −41 %, vendors −39 %) and
  cuts main's by a third in modules (−18 % bytes). Its value is real, and largest where barrels fan
  out (website).
- **The 220 KB website budget is out of reach by laziness alone.** The code that *ran* before the
  heading was ~1.08 MB raw (~295 KB br *est.*) first-party before any closure, in: website pages
  (108 KB raw), `primitives/css` (93), `network/live` (135), `media/player` (58 — the hero video),
  `primitives/pane`, tokens/icons/theme-engine, `adaptive-bar`, `reports/main-thread-stall`,
  `shell/notifications`, `infra/runtime-profiler`. Some of that is boot-root work §7.1 would gate
  (reporters, profiler, notifications), most is the route itself. Vendors alone are 337 KB br
  (react-dom, zod, base-ui, floating-ui, dnd-kit, lexical, react-query, sonner…).
- Closure overhead is ~45 % of the M2 set (868 KB raw of statically imported but never-run modules on
  `/about`: dropdown-menu, color-picker, control-panel rows, field views) — the render probe being
  needed is confirmed, and so is the value of splitting at the *component* edge inside impls too.
- **Route sets barely differ between website routes** (998–1,074 modules): the shared shell + runtime
  dominate, so per-route sets buy little over one website-wide set; the win is versus the
  composition, not between routes.

### 12.4 Q4 — warm-cache first use of not-yet-evaluated code (main)

Method: `/agents` loaded twice in one persistent context (HTTP cache on, no routing, deferred tier
drained). Then, inside a fresh same-origin `srcdoc` iframe carrying only the page's import map,
so it has an empty module map over the warm HTTP and code cache: `<link rel=modulepreload>` the
set and await the `load` events (cache fetch + compile), then `import()` it (link + top-level
evaluation). Every resource had `transferSize` 0 (all from cache). The host was loaded
(load average 14–20): read medians, with the best case in brackets.

| What | Modules | Raw | Preload (cache + compile) | `import()` (link + evaluate) |
|---|---|---|---|---|
| Today's eager set | 1,656 | 15.5 MB | 244 ms | **1,790 ms** (best 1,130) |
| One deferred leaf (median of 10 sampled) | 1–17 | 1–790 KB | 16–41 ms | 1–13 ms |
| All 199 deferred plugins together | 282 | 7.1 MB | 78 ms | 442 ms |

- **On a warm load, evaluation costs 5–10× the cache fetch + compile.** Warm cost scales with the
  number of modules evaluated (~1 ms per module for the eager set), not with bytes.
- §1.3/§6.1 quote ~0.9 s for eager evaluation. Measured here: 1.1 s at best, 1.8 s median under
  fleet load.
- **First use of a not-yet-evaluated leaf costs ~20–55 ms**, mostly fixed per-load overhead.
  That fits inside a navigation transition.
- Extrapolating ~1 ms per module, a pane closing over ~100–300 new modules would cost ~0.1–0.4 s
  warm. This is not measured directly: today's heavy apps (pages, studio, sonata) are not deferred.
  They are pinned eager through the `dependsOn` closure, and `apps/studio/web` and `apps/sonata/web`
  are not in main's import map at all. The deferred tier holds only leaves.
- Target vs today for main `/agents`: the M2 route set (§12.3) is 2,092 source modules, against
  5,583 in today's eager set. If evaluation tracks module count, warm boot evaluation drops by
  roughly 1.1 s (est.). This is the largest warm-app win the numbers support.

### 12.5 Q5 — protocol, and queueing on a cold local load (D0)

- **Local gateway: HTTP/1.1 only** — `curl --http2` negotiates 1.1, `--http2-prior-knowledge` gets
  no answer (no h2c), no TLS listener. Browsers would only use h2 over TLS anyway. **equin.ai:
  HTTP/2** (Caddy), `alt-svc: h3=":443"` advertised. So the six-connection limit applies to every
  local namespace and to nothing deployed.

Measurement: a cold local load (CDP cache disabled, so every artifact URL is new, as right after
a build), 6 runs per target, fleet load 13–48. Every request was `http/1.1`. Each run used 6
connections with at most 6 in flight. Median [range], seconds from navigation:

| | website `/about` | main `/agents` |
|---|---|---|
| Requests (preloads + later modules) | 662 (614 + 35) | 1,973 (1,657 + 293) |
| Wait for a socket per request, p50 / p90 | 0.33 / 0.60 | 0.52 / 1.03 |
| Last modulepreload done | 0.72 [0.26–1.78] | 1.45 [0.70–6.72] |
| Route content painted | 2.16 [1.35–6.32] | 7.59 [3.76–17.2] |
| Time ≥ 1 request queued, as a share of the preload phase | **97 %** | **99 %** |
| … as a share of time to paint | **31 %** | **20 %** |
| Unlimited-connection lower bound for the preload phase | 0.11 | 0.27 |
| Upper bound on what h2 could save | 0.60 | 1.18 |

- **The local preload phase is entirely bound by the 6-socket HTTP/1.1 pool.** It is still only
  20–31 % of time to paint. On `/agents`, paint comes ~6 s after the last preload: evaluation,
  boot, snapshot, and 293 later module requests.
- **Sockets were only 47–61 % busy, at ~2 ms per request.** Chromium's per-request overhead stays
  under h2, so the real h2 saving sits well under the upper bound (≈ the "never idle" figure:
  0.29 s / 0.76 s).
- **Request count is the cost, not bytes** (10.7 MB from localhost is cheap).

D0 answer: local h2 (TLS on `*.localhost`) would buy at most ~0.6–1.2 s on a cold local load,
likely about half that, and nothing on equin.ai, which is already h2. Fewer requests buy the same
on both protocols. M2's module-granularity output would multiply requests (`/about`: ~1,130
modules + vendor files vs 662 today), so **route chunks (M6) are a precondition of M2/M4**,
not the optional "if request count shows up" the doc has.

### 12.6 Verdict

**Still worth it — but as "smaller eager sets + module-granular imports", not as "tiny manifests +
~40-module route sets". Several of the doc's sizing assumptions are off by 5–25×.**

Confirmed:
- M2 is feasible with the existing builder (`preserveModules`; 62/62 targets, one module per file,
  names kept). It cuts the website route set roughly in half (modules −48 %, bytes −41 %) and main's
  `/agents` by a third in modules. Do it, together with route chunks.
- Warm-app first use of a lazily evaluated leaf is cheap (~20–55 ms). Evaluation, not fetching,
  is the warm cost, so shrinking the evaluated set is the win (~1.1 s est. on `/agents`).
- Images out of JS (Q3) is worth doing on its own: 395–686 KB raw of base64 sits in every website
  route's closure.

Contradicted, so the doc should change:
1. **"Manifests are small enough to always load" (§4.1, §4.4, §10)** is false as modelled.
   - Stubbing every component leaves 449 KB br (website) / 563 KB br (main) of first-party code,
     plus 432 KB br of npm (lexical, zod, yjs, parsers…), across 4,651 / 5,866 modules. That is more
     modules than today's whole website eager set.
   - M3 must make heavy *data* lazy too: node classes, parsers, schema-heavy descriptors, icon-name
     tables.
   - Alternatively, load manifests per drawn host rather than per composition.
   - The `manifests` budget (60 / 150 KB) is ~8× under today's reality.
2. **Route sets are ~1,000–2,100 modules, not "~40" (§4.4, §6.1).**
   - Website: ≈ 530 KB br (est.) + 337 KB br vendors, against the 220 KB budget.
   - The code that merely *ran* before the heading is already ~295 KB br (est.) + vendors. Laziness
     alone cannot reach 220 KB: the shared shell, `network/live`, `primitives/css`, the player and
     the boot roots have to shrink too.
   - Reset §4.6's placeholders to measured values (website `*` ≈ 900 KB br incl. vendors, main
     ≈ 1.8 MB), and ratchet down from there.
3. **Per-route sets barely differ on the website** (998–1,074 modules across 5 pages). The win is
   composition → website-wide set, not one route vs another. A single website set plus per-page
   deltas is enough, and simpler than per-route sets spliced by the gateway.
4. **Route chunks are a precondition, not M6's optional step.**
   - Per-module files cost +24 % brotli (median; +75 % for data-view).
   - On HTTP/1.1, the local preload phase is already 97–99 % queued.
5. **D0:** keep HTTP/1.1 locally and fix the request count with route chunks. Local h2 would buy
   ≤ 0.6–1.2 s cold, and nothing on equin.ai.
6. **§7.1 matters more than it reads.** Boot-root work (reporters, runtime profiler, notifications,
   main-thread-stall) runs on the website before the heading, so activation events are part of the
   route-set budget, not a nicety.
7. **For the website, pre-render (M7) is what fixes paint.** A ~0.9 MB hydration set makes the
   "hydration window" of §5.3 seconds long on fast 4G rather than "short". Keep M7 behind M2 + route
   chunks, but do not expect the window to close without the budget work above.
