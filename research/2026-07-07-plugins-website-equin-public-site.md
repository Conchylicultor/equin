# Website app — the public-facing site of Singularity (equin)

## Context

Singularity's public brand is **equin** (domain equin.ai). The deployment roadmap
([2026-05-04-global-equin-ai-deployment-roadmap.md](./2026-05-04-global-equin-ai-deployment-roadmap.md))
plans a stripped-down public deployment serving a blog, download page, and interactive demo.
Its "Step 3 — profile system" has since landed as the composition/release engine; this plan is
**Step 4: the site itself**, built as a normal Singularity app so it can be authored, previewed,
and iterated locally today.

Scope decisions (confirmed with the user):

- **App only.** Public hosting (server, gateway `-base-domain`, deploy transport) and the public
  release composition are deferred — separate roadmap steps. The app runs inside the normal shell
  at `http://<worktree>.localhost:9000/website`.
- **Blog authored in the Pages app** (Notion-like CMS); the website renders published pages read-only.
- **Demos:** theme-customizer toy ships in v1; block-editor toy and read-only agent-manager tour are
  filed as follow-up tasks.
- **Branding: equin** — in copy/tooltip/wordmark only; the plugin id stays neutral (`website`),
  matching the repo convention of capability-descriptive ids (`home`, `pages`, `story`).
- **Must look professional and modern** — polish is its own phase run per
  [`sidequests/ui-mastery/CLAUDE.md`](../sidequests/ui-mastery/CLAUDE.md) (feature agents build
  function; a separate polish agent applies craft).

A design constraint throughout: the eventual public composition must be able to include only this
app + a lean dependency closure. Don't import agent-manager internals (the app-tour follow-up is
gated on the read-only-profile work for exactly this reason).

## Plugin tree

Top-level plugin is an empty namespace (create-app rule); all content in sub-plugins. Each section
is its own sub-plugin contributing into shell-owned slots (collection-consumer separation — the
shell never names contributors).

```
plugins/apps/plugins/website/
  package.json                        # umbrella, description only
  web/index.ts                        # empty namespace: { description, contributions: [] }
  plugins/
    shell/                            # app entry + bespoke marketing layout + slots + panes
      core/app.ts                     #   defineApp({ id: "website", basePath: "/website", iconKey: "public" })
      web/index.ts                    #   Apps.App(...), Pane.Register(all panes), exports Website slots
      web/slots.ts                    #   Website.NavItem, Website.Section (both defineRenderSlot, ordered)
      web/panes.tsx                   #   landingPane (index), blogListPane, blogPostPane, downloadsPane
      web/components/website-layout.tsx  # Column: nav header (rigid) / FullPane body / footer (rigid) + PaneOverlayHost
      web/components/website-nav.tsx      # equin wordmark + <Website.NavItem.Render/> + Download CTA
      web/components/website-footer.tsx
    landing/                          # umbrella (package.json only)
      plugins/hero/web/…              #   Website.Section (order 10): headline, subhead, CTAs
      plugins/features/web/…          #   Website.Section (order 20): feature grid, copy in core/ array
      plugins/cta/web/…               #   Website.Section (order 90): closing get-started band
    downloads/
      core/downloads.ts               #   closed platform matrix (see Downloads)
      web/index.ts                    #   Website.NavItem "Download" + downloads pane body
      web/components/downloads-page.tsx
    blog/                             # umbrella (package.json only)
      plugins/publish/                #   side-table + resource + endpoints + hooks (mirror story/marker)
        server/internal/{tables,resource,routes}.ts
        server/index.ts
        shared/endpoints.ts
        web/{index,hooks}.ts
      plugins/pages-integration/      #   authoring affordance inside the Pages app
        web/index.ts                  #     PageDetail.Section({ id: "blog" })
        web/components/blog-publish-panel.tsx
      plugins/site/                   #   public blog surfaces
        web/index.ts                  #     Website.NavItem "Blog"
        web/components/{blog-list,blog-post}.tsx
    demos/                            # umbrella (package.json only)
      plugins/theme-toy/              #   v1 demo — self-contained, no persistence
        web/index.ts                  #     Website.Section (order 30)
        web/components/theme-toy.tsx
      # FOLLOW-UPS (filed as tasks, not built): editor-toy/, app-tour/
```

## Shell design

- **Registration** (`shell/web/index.ts`): `Apps.App({ id: websiteApp.id, icon: mdAppIcon(MdPublic), tooltip: "equin", component: WebsiteLayout, path: websiteApp.basePath })`.
  Mirror `plugins/apps/plugins/story/plugins/shell/{core/app.ts, web/index.ts}`.
- **Layout — bespoke, no app sidebar** (precedent: Home's hand-built layout,
  `plugins/apps/plugins/home/plugins/shell/web/components/home-layout.tsx`). A `Column` frame:
  - header (rigid): `<WebsiteNav/>` — wordmark, `Website.NavItem.Render`, primary Download CTA;
  - body (flexible): `<FullPane/>` from `@plugins/layouts/plugins/full-pane/web` — paints the active
    section pane full-surface while header/footer stay fixed;
  - footer (rigid): `<WebsiteFooter/>`;
  - plus `<PaneOverlayHost/>` (as Home does) so global overlay panes still resolve here.
- **Navigation model:** panes per section (screen-stack, `mode: "root"` opens, browser back works):
  `landingPane` (index at `/website`), `blogListPane` (`/blog`), `blogPostPane` (`/blog/:slug`),
  `downloadsPane` (`/download`). The landing pane is a long-scroll `<Website.Section.Render/>`
  composition — the classic marketing feel.
- **Marketing look:** two levers, both deferred to the polish phase —
  1. composition (hero type via `Text` variants, `Grid` tiles, `Surface`/`Card`, token-based
     gradient bands — semantic tokens only, lint-enforced);
  2. the per-app theme fork (`data-theme-scope="app:website"`, theme-engine app-scope config,
     `plugins/ui/plugins/theme-engine/core/config.ts`) with a distinctive preset + Google display
     font (`plugins/ui/plugins/tokens/plugins/font-family/plugins/google-fonts/`).
  The app is fully functional on the default theme; the fork is polish, not a blocker.

## Blog pipeline

Mirror the story/marker precedent byte-for-byte
(`plugins/apps/plugins/story/plugins/marker/{server/internal/{tables,resource,routes},shared/endpoints,web/{index,hooks}}.ts`).

- **Side-table** (`blog/plugins/publish/server/internal/tables.ts`) via
  `defineExtension(_blocks, "blog_post", …)` from `@plugins/infra/plugins/entity-extensions/server`:
  `page_blocks_ext_blog_post(parent_id PK FK→page_blocks CASCADE, slug NOT NULL, summary NULL, published_at NULL)`.
  `publishedAt` null = draft; set = published. Re-export `_blogPostExt` for drizzle-kit's glob.
- **Live resource** `blogPostsResource` (mirror `storiesResource`): ext table joined to the page
  block for `title`/`icon` (from `page_blocks.data`), filtered `publishedAt IS NOT NULL`, ordered
  `publishedAt desc`. Payload: `{ pageId, slug, title, summary, publishedAt }` — the slug→pageId map.
- **Endpoints:** `PUT /api/blog-posts/:pageId` (`{ slug, summary?, published }` upsert) and
  `DELETE /api/blog-posts/:pageId` (unpublish). Web hooks: `useBlogPosts()`, `useBlogPost(pageId)`,
  `publishPost`/`unpublishPost` — exact shape of `useStories`/`useIsStory`/`markStory`.
- **Authoring affordance** (`blog/plugins/pages-integration`): contribute
  `PageDetail.Section({ id: "blog" })` (precedent:
  `plugins/apps/plugins/story/plugins/pages-integration/web/index.ts`). Panel: Publish toggle,
  editable slug (defaulted from title), summary, "View on site" link opening `blogPostPane`.
- **Public rendering — reuse `ReadOnlyBlocks`, not a Story lens** (the Story "blog" lens is
  AI-generation, not a faithful renderer). `blog-post.tsx`:
  1. resolve `:slug → pageId` via `useBlogPosts()`;
  2. `useResource(blocksResource, { pageId })` from `@plugins/page/plugins/editor/core`;
  3. rows → forest → `<ReadOnlyBlocks forest={forest}/>` from `@plugins/page/plugins/read-only-view/web`.
  Gate on resource state — never collapse pending → `[]` (see
  `plugins/apps/plugins/pages/plugins/history/web/components/page-version-preview.tsx` for the
  exact consumer pattern).
- **Lift `buildForest` into read-only-view's public API.** The flat-rows→`ReadOnlyNode[]` transform
  currently lives internal to pages/history
  (`plugins/apps/plugins/pages/plugins/history/web/internal/build-diff.ts`). It is the canonical
  transform and both consumers need it — move it into
  `plugins/page/plugins/read-only-view/web/` and re-point pages/history. Removes a duplication
  rather than adding one.
- **Known fidelity gap (accepted for v1):** `ReadOnlyBlocks` renders embed/bookmark/video/audio/file
  as placeholder cards. Authors prefer supported blocks; faithful renderers are a follow-up.

## Downloads page

- **v1 data source: `core/` closed-list constant** (`downloads/core/downloads.ts`) — the platform
  matrix is fully enumerable today, so per the web-sdk rule it's plain `core/` data, not config_v2
  and not a slot. Entry: `{ platform, label, icon, href, status: "available" | "coming-soon" }`.
  Hosting of real artifacts is deferred, so v1 entries are `coming-soon` (disabled buttons) with
  GitHub-Releases-style placeholder hrefs. Upgrade path with zero rework: swap hrefs, or promote to
  config_v2 if URLs must ever change without a rebuild.
- **Design:** "Download equin" hero line, `Grid` of platform cards, detected-OS highlight.

## Landing page

- Sections as independent sub-plugins (hero / features / cta + the theme-toy strip), each a
  `Website.Section` contribution — independently polishable and reorderable via the reorder primitive.
- **Copy lives hardcoded in components backed by `core/` data arrays** — product-owned,
  version-controlled; the CMS is reserved for the blog.
- Layout via css primitives only: `Column`/`Stack` rhythm, `Grid` tiles, `Center` hero, `Card`/
  `Surface`, `Text` variants. Read the `css` + `theme` skills before this work.

## Demos

- **theme-toy (v1):** a sample surface (mock card cluster) inside a wrapper carrying its own
  `data-theme-scope`, with a `SegmentedControl` of presets restyling only that scope via the
  existing theme-engine machinery. Self-contained, no persistence, real capability showcase.
- **editor-toy (follow-up task):** `BlockEditor` is bound to a persistent `pageId` (reads
  `blocksResource`, writes server endpoints); no in-memory mode exists. The clean answer is a new
  `persist={false}` in-memory mode on the editor (benefits the editor generally) — non-trivial,
  so file it with that design note. A v1-lite stand-in if ever wanted: static `ReadOnlyBlocks`
  over a canned doc.
- **app-tour (follow-up task):** the `ScaledIframe` idiom exists
  (`plugins/apps/plugins/prototypes/plugins/gallery/web/components/scaled-iframe.tsx`), but a real
  tour drags agent-manager's closure into the site and an honest read-only tour depends on the
  deferred read-only-profile work. Gate the task on that.

## Phasing (each phase an independent agent-sized task)

1. **Scaffold** — namespace + `shell` (app entry, slots, panes, bespoke layout, PaneOverlayHost).
   `./equin build` → app appears at `/website` with an empty landing.
2. **Landing** — hero / features / cta sections + copy arrays.
3. **Downloads** — `core/downloads.ts` + pane + nav item.
4. **Blog backend** — `blog/publish` (side-table, resource, endpoints, hooks) +
   `blog/pages-integration` (publish panel). Includes the migration (via `./equin build`).
5. **Blog frontend** — lift `buildForest` into read-only-view (re-point pages/history), then
   `blog/site` list + post panes.
6. **Demo v1** — `demos/theme-toy`.
7. **UI-polish pass** — one dedicated polish agent per ui-mastery: marketing theme fork (preset +
   display font for the `website` scope), type/spacing/hero/gradient treatment, responsive +
   motion. No functional changes.
8. **File follow-up tasks** (via `add_task`): editor-toy (with `persist={false}` design note),
   app-tour (gated on read-only profile), faithful read-only renderers for embed/media blocks,
   "equin-site" public composition + local F4 release smoke-test, and the roadmap's hosting steps.

## Verification

- `./equin build`, then `./equin check` (registry sync, boundaries, lints).
- Open `http://<worktree>.localhost:9000/website`:
  - rail icon present; landing renders with fixed header/footer, no app sidebar; nav opens
    Downloads/Blog panes and browser back returns.
  - Downloads grid renders with disabled coming-soon buttons.
  - **Blog round-trip:** in Pages, publish a page via the new Blog section (slug + summary) →
    appears in `/website/blog` → `/website/blog/:slug` renders blocks faithfully; an embed block
    degrades to a placeholder (documents the gap). Unpublish → disappears from the list.
  - Theme-toy preset switch restyles only the sample surface.
- Scripted screenshots via `e2e/screenshot.mjs`: landing, downloads, blog list, a post, theme-toy
  before/after.

## Critical files

Create (most load-bearing):
- `plugins/apps/plugins/website/plugins/shell/{core/app.ts, web/index.ts, web/slots.ts, web/panes.tsx, web/components/website-layout.tsx}`
- `plugins/apps/plugins/website/plugins/blog/plugins/publish/server/internal/tables.ts`
- `plugins/apps/plugins/website/plugins/blog/plugins/pages-integration/web/index.ts`
- `plugins/apps/plugins/website/plugins/blog/plugins/site/web/components/{blog-list,blog-post}.tsx`
- `plugins/apps/plugins/website/plugins/downloads/core/downloads.ts`

Modify:
- `plugins/page/plugins/read-only-view/web/` — export `buildForest` (lifted from pages/history);
  re-point `plugins/apps/plugins/pages/plugins/history/web/internal/build-diff.ts`.
- Autogenerated registries regenerate via build — never hand-edit.

Key reuse (paths):
- marker precedent: `plugins/apps/plugins/story/plugins/marker/…`
- `ReadOnlyBlocks` / `ReadOnlyNode`: `plugins/page/plugins/read-only-view/web/`
- `blocksResource`: `plugins/page/plugins/editor/core/resources.ts`
- app entry precedent: `plugins/apps/plugins/story/plugins/shell/`
- bespoke layout + `PaneOverlayHost`: `plugins/apps/plugins/home/plugins/shell/web/components/home-layout.tsx`
- `FullPane`: `plugins/layouts/plugins/full-pane/web`
- authoring panel precedent: `plugins/apps/plugins/story/plugins/pages-integration/web/`
- per-app theme fork: `plugins/ui/plugins/theme-engine/core/config.ts`; fonts:
  `plugins/ui/plugins/tokens/plugins/font-family/plugins/google-fonts/`
- consumer pattern for blocks→forest→render:
  `plugins/apps/plugins/pages/plugins/history/web/components/page-version-preview.tsx`
