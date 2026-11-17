# A composition's root app: serve one app at `/` on a released site

## Context

The public site (the `website` composition, deployed to equin.ai) lives under the
website app's base path: `equin.ai/about/vision`. The user wants the released
site to drop the prefix (`equin.ai/vision`) while the local instance keeps the
app at `/about` — where it shares the top-level address space with every other
app, and where owning `/` would make it the catch-all (swallowing the launcher
redirect and every unowned URL).

So the base path stays what it is everywhere *inside* the app; only a released
composition's **address** (the URL bar, rendered hrefs, the snapshot manifest,
the sitemap) drops it. Generic: any composition may name one root app.

## Design: an address mapping at the URL boundary, not a second base path

Changing `AppRef.basePath` per composition was rejected: the base path is a
statically imported constant read by `route.link()`, `defineWebsitePage`, the
pane identity check, the static renderer, `declaredApps()` and ~15 browser
readers — an override would have to reach all of them, and two values of one
fact would drift.

Instead, one pure bijection between **route paths** (internal, unchanged:
`/about/vision`) and **address paths** (what the browser shows:
`/vision`), applied only where a path crosses the browser boundary. Those
crossings are already funnelled by lint (`pane/no-raw-location-path`,
`apps-core/no-raw-history-nav`), so the mapping has a handful of sites.

### 1. The mapping primitive — `primitives/pane/core` (beside `joinBasePath` / `normalizeRoutePath`)

```ts
/** The app a composition serves at `/`: its base path is dropped from the address. */
export interface AddressRoot { readonly basePath: string } // e.g. "/about"; null = identity
export function toAddressPath(routePath: string, root: AddressRoot | null): string;
export function toRoutePath(addressPath: string, root: AddressRoot | null): string;
```

- `toAddressPath("/about/vision")` → `/vision`; `"/about"` → `/`; `"/about;k=v"` → `/;k=v`.
- `toRoutePath("/vision")` → `/about/vision`; `"/"` → `/about`.
- A route path outside the root app under a root is **inexpressible** in the
  address → throws (a released root composition shows only its root app; an
  embedded demo app renders in-process under the root app's own routes,
  `/about/demo/at/sonata`, so it never needs one). Round-trip property-tested.

### 2. The composition field — `rootApp`

- `plugin-meta/composition/core/config.ts:232-266`: `rootApp: textField({ label: "Root app" })`
  beside `home` / `unlisted`. Validated with them (`composition-closure` check,
  `resolveRegistryHome`'s sibling in `codegen/core/plugin-registry-gen.ts`): an
  app id in the bundle, and `home` must be empty or equal it (the root app IS the home).
- Emitted into the generated `composition: CompositionIdentity` (`plugin-registry-gen.ts`
  ~835-857, and `browser-host-gen.ts` / `static-host-gen.ts`) as the resolved
  `addressRoot: { basePath } | null` — resolved at codegen, so the browser does
  no lookup. `CompositionIdentity` in `framework/web-sdk/core/context.tsx:215`
  gains the field; `PluginScope` embedded scopes carry `null` (they own no address bar).
- Server side: the same resolved value in the server composition registry, read by
  `declaredApps()`'s neighbour so the sitemap and head renderers see it.
- `config/plugin-meta/composition/compositions.origin.jsonc` website row:
  `"rootApp": "website"`. Main and every desktop composition: unset → identity.

### 3. Browser boundary sites (all already lint-funnelled)

- **Read**: `currentRoutePath()` in `primitives/pane/web/pane.ts:~2840` and the eager
  boot read in `web-core/web/App.tsx:261` → `toRoutePath(normalizeRoutePath(location.pathname), root)`.
- **Write**: the pane store's `setRoute` and apps-layout's pre-tab
  canonicalization (`apps-layout.tsx:63`) → `toAddressPath(url, root)`.
- **Rendered hrefs**: `route.link()` stays a route path (navigate() takes route
  paths); the anchor that renders it (`href` for copy / open-in-new-tab /
  crawlers) maps through `toAddressPath`. Implementation step 1: locate every
  `<a href={…link(…)}>` site — expected to be the pane link primitive; if raw
  anchors exist, add a lint rule beside `no-raw-location-path` rather than map
  them one by one.
- The root is set once by `App.tsx` from the imported `composition` before
  mount (`setAddressRoot(composition.addressRoot)`); reading before it is set
  throws (no silent identity default).

Everything downstream of those sites — `resolveAppForPath`, tabs, analytics
tracking (records the pane route path), `defineWebsitePage`, pane identities,
`pages-declared` — keeps seeing `/about/...` and is unchanged.

### 4. Released-site outputs (external = address paths)

- **Snapshot manifest** (`static-renderer.tsx:157-199`, `render-snapshot.ts`,
  `crawlable/core/internal/{snapshot,manifest}.ts`): page keys are address paths
  (`/`, `/vision`); `snapshotFileOf("/")` → `index.html`; `home` omitted when the
  composition has a root app (`/` is a page, not a redirect); `moved` gains
  `{"/about": "/", "/website": "/"}` (the root app's base path and its former
  ones, all mapped to the root).
- **Manifest contract, both sides** (`crawlable/core/internal/manifest.ts`,
  `gateway/snapshot.go:218-258`): allow page `/`, and a `moved` target of `/`
  (source still never `/`); `movedTarget` joins `"/" + tail` without a double
  slash (`/about/vision` → `/vision`, `/about` → `/`, `/about;k=v` → `/;k=v`).
  Old README / search-engine `/about/...` links keep working through this 301.
- **Sitemap** (`crawlable/server`): entries mapped through `toAddressPath`.
- **Server head by path** (theme head, app-preload head, `poster-head.ts`
  longest-match keys, PWA manifest `start_url`/`scope`): map the request path
  with `toRoutePath` before matching apps — one helper beside `declaredApps()`.

### 5. Public-site links outside the app

- `website/shell/core/site.ts:80-98` (`localSiteUrl` / `publicSiteUrl`, the
  browser extension's Open locally / Open on equin.ai): no longer a pure origin
  swap — map with `toRoutePath` / `toAddressPath` and the website's root. This
  file states "the public site serves the website app at its root", owned in one place.
- `hints/help-menu/web/components/entries.tsx:20` `GUIDE_URL` → `publicSiteUrl(guidePage.path)`.
- Session replay (`analytics/sessions/local-path.ts`): recorded paths are pane
  route paths → unchanged. Verify `collect/web/internal/tracker.ts:355`'s
  `fallbackPath` is a route path too (map it if it is the raw address);
  server-recorded referrer/landing paths (`request-context.ts:108`) are address
  paths — map with `toRoutePath` where replay reads them.
- `README.md`: drop `/about` from the equin.ai links.
- Docs: website `CLAUDE.md`, crawlable `CLAUDE.md` (manifest contract),
  `gateway/CLAUDE.md`, `local-path.ts` comment.

## Critical files

- `plugins/primitives/plugins/pane/core/route.ts` (mapping), `pane/web/pane.ts` (read/write sites)
- `plugins/framework/plugins/web-core/web/App.tsx`, `apps-core/plugins/layout/web/components/apps-layout.tsx`
- `plugins/plugin-meta/plugins/composition/core/config.ts`, `framework/plugins/tooling/plugins/codegen/core/plugin-registry-gen.ts` (+ browser/static host gens), `framework/plugins/web-sdk/core/context.tsx`
- `plugins/apps/plugins/website/plugins/crawlable/**` (manifest, snapshot, sitemap), `primitives/plugins/dom/plugins/static-render/web/internal/static-renderer.tsx`
- `gateway/snapshot.go`, `gateway/proxy.go:265-278`
- `plugins/apps/plugins/website/plugins/shell/core/site.ts`, `plugins/hints/plugins/help-menu/web/components/entries.tsx`
- `config/plugin-meta/composition/compositions.origin.jsonc`, `README.md`

## Conflicts / risk

- Local instance: no behaviour change (no composition there names a root app).
- Edits are concentrated in the composition codegen, the pane boundary and the
  crawlable manifest; the ~50 `/about` test literals stay valid (route paths are unchanged).
- Gateway change ships via main's gateway auto-rollout; manifest reader and
  writer change together (strict parsing on both sides).

## Verification

- Unit: `toAddressPath`/`toRoutePath` round-trip and the throw; manifest schema
  (page `/`, moved → `/`); `snapshotFileOf("/")`; gateway `snapshot_test.go`
  (`/about/vision` → 301 `/vision`, `/website/story` → 301 `/story`, `/` serves the snapshot).
  `./equin test` on pane, crawlable, composition, codegen; `go test ./gateway/...`.
- `./equin check` (composition-closure, plugins-registry-in-sync, pages-declared).
- Local: `./equin build`, open `/about/vision` on the worktree — unchanged.
- Released: `./equin build --composition website`, serve it, drive with
  `browser_*`: `/vision` renders, in-site nav writes `/story` (no `/about`),
  hrefs have no `/about`, `/about/apps` 301s to `/apps`, bare `/` shows the
  landing page; screenshot before/after.
