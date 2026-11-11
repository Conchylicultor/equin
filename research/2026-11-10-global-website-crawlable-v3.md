# Make the public website crawlable, v3: the spike's findings and the decisions taken

Supersedes `…-crawlable-v2.md` where they differ; everything not restated here stands as written in v2 (the hidden snapshot beside `#root`, `defineWebsitePage`, robots.txt and sitemap.xml per request).

## The spike (step 0): GO with caveats

The throwaway script `plugins/apps/plugins/website/scripts/static-render-spike.ts` rendered Download, Landing and Foundations with `renderToStaticMarkup` in Bun. It loaded the code through barrel-import and used the real providers: `TransportProvider` → `NotificationsProvider` → `PluginProvider` → `PaneSurfaceProvider` with `createPaneStore({ live: false })`.

- **Load and render:** about 2 s to load, about 0.1 s per page.
- **Text:** all present, the iceberg's included.
- **Slot order:** landing sections render in `section.jsonc` order.

What blocked it is listed under step 1, with the fix for each.

## Decisions

1. **Only crawlable compositions build a snapshot.**
   - A composition opts in with `crawlable: true` in `config/plugin-meta/composition/compositions.origin.jsonc` (`website`).
   - Main's build and ordinary worktree builds pay nothing.
   - It runs for a release or deploy of the website, and for `./equin build --composition website` (`http://website.localhost:9000`).
2. **The snapshot is a cached artifact of the existing host-snapshot stage** (`tooling/web-artifacts`, `artifacts:host-snapshots`). Its cache key is derived from its import graph plus the data it reads, so it reruns only when website code or config changes, and every checkout shares it. A take costs about 4–5 s.
3. **Config and boot data come from an in-process host boot**, reusing the workspace demo's path (`demos/workspace/bin/browser-host.snapshot.ts`):
   - `bootBrowserHost({ entries })` loads the composition's server half on PGlite, opened from the cached initialized cluster;
   - the boot snapshot is produced in-process;
   - it is fed to the real hydrate path (`resourceDescriptorByKey` + `hydrateResource`);
   - then each declared page is rendered.

   No live server is involved.
4. **Links: `href` in the static render only.**
   - A new leaf, `primitives/render-mode` (core), with `declareRenderMode("static")`, called once by the static-render process before loading anything, and `renderMode(): "live" | "static"`, which defaults to `"live"`.
   - `link-gesture`'s `linkProps` adds `"data-link": href()` when `renderMode() === "static"`. The existing href thunk is the one `openPane.to` builds; it is computed against the static pane store.
   - The snapshot's semantic filter turns `[data-link]` into `<a href>`.
   - The live app is unchanged. A throwing `href()` fails the build and names the page.

## Steps

### Step 1: building-block fixes

Each fix is made in the building block itself, with a test that statically renders it.

| Area | Fix |
|---|---|
| **Render mode and links** | Create `primitives/render-mode` and add `data-link` to `linkProps` (`link-gesture/web/internal/link-gesture.ts:51`). |
| **Collapsible** | Closed content stays in the DOM, hidden with `hidden="until-found"`, so a static render and find-in-page include it. Check the visual and animation behaviour is unchanged. |
| **`useSyncExternalStore` server snapshot** | Pass `getServerSnapshot` at `config_v2/web/internal/use-config.ts:123`, `use-set-config.ts:21`, `ui/icons/web/internal/icon.tsx:52,183,187,190,195`, `infra/endpoints/web/internal/asset-src.ts:168`, `media/player/web/components/player.tsx:214,227` and `timeline.tsx:26`. Add a lint rule requiring the third argument, repo-wide. |
| **NotificationsClient** | Stop opening the socket in the constructor (`notifications-client.ts:828` → `:2039`); open it lazily on first subscribe or connect. |
| **No-DOM rendering** (after render-mode exists) | `createPortal` in `adaptive-bar/web/internal/bar-item.tsx:244`, `viewport-overlay.tsx` and `media-player.tsx` renders in place, in its natural order, when `renderMode() === "static"`. DOM globals read during render (`document-pip.ts:23` via `media-player.tsx:75`, `timeline.tsx:37`'s `instanceof HTMLVideoElement`, `bar-item.tsx:125`'s `document.createElement` in `useState`) move to effects or lazy access. Add a lint rule against DOM globals in a render body, if it can be made precise enough. |

### Step 2: the static-render primitive

`primitives/static-render`:
- `renderPaneStatic({ registry, pane, path, bootSnapshot })`, which provides the provider stack above;
- the semantic filter, including the `data-link` → `<a href>` conversion.

### Step 3: the `crawlable` plugin and the artifact

The `crawlable` plugin (under `apps/website`):
- `core`: `defineWebsitePage` and the manifest schema;
- `web`: `websitePane`;
- `server`: the `WebsitePages.Page` collection, robots.txt and sitemap.xml;
- the check that every website pane is contributed on the server.

The snapshot artifact goes in the host-snapshot stage, gated on `crawlable`. The website pages migrate to `defineWebsitePage` and `websitePane`.

### Step 4: serving

- The gateway inserts the snapshot (`gateway/snapshot.go`) and forwards `/robots.txt` and `/sitemap.xml`.
- Verification as in v2.

The spike script is deleted at the end; until then it stays as the integration probe. Each step-1 fix should let it drop the matching stub.
