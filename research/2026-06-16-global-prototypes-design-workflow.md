# Prototypes: a streamlined UI design-iteration workflow (phase 1)

## Context

The current app layout (the "panes" — `layouts/miller`, framing, the live shell) doesn't satisfy the user, and they want a clean way to **iterate on UI design**. There are already hand-made mockups outside the repo in `~/__A__/dev/design/` (two sets: `singularity/` and `equin 2`/Helix), built as standalone HTML + JSX + CSS using CDN React + Babel-in-browser.

The agreed model is **two phases**:

1. **Prototype phase** — fast, throwaway mockups to explore design ideas. *(this plan)*
2. **Integration phase** — port liked ideas back into the real app as variants/themes. Built **later, on demand** — explicitly out of scope here.

This plan smooths phase 1: **standardize the existing prototypes** and give the app a surface to **browse, compare, and iterate** on them.

### Problem with today's prototypes

Each mock duplicates ~150 lines of non-design scaffolding: a `Stage` scaler, a `Compare` 3-up grid, a chrome bar, CDN `<script>` tags, hand-written OKLCH token blocks, and invented fixture data (`RUNS`/`EVENTS`/`PUSHES`). They live outside the repo, can't be browsed in-app, and drift visually from the real product.

### Key correction from exploration

The mocks implement a `__activate_edit_mode` / `__edit_mode_set_keys` postMessage protocol. **This protocol is invented fiction** — zero references anywhere in the repo (the real edit-mode/improve/theme flows are all same-document in-process React). So phase-1 iteration must NOT depend on a live postMessage tweak bridge. Instead: **an agent edits the prototype files; the iframe auto-reloads.**

## Approach

A repo-root `prototypes/` dir (tracked, sibling to `research/`/`sidequests/`) holding a **shared harness** + one folder per mock, served raw to the browser, surfaced by a new **Prototypes** app with gallery / Focus / Compare and push-based reload.

A prototype shrinks to: `meta.json` + an `App` component + optional styles. The harness, tokens, fixtures, and Focus/Compare chrome are all shared / app-owned.

### 1. Repo-root `prototypes/` directory

```
prototypes/
  _shared/
    harness.html      # CDN React/ReactDOM/Babel/lucide + <div id="root">; reads window.__PROTO_NAME__
    harness.js        # fetches the prototype's meta.json, injects its <link>/<script type="text/babel"> tags, mounts window.App into #root
    tokens.css        # design tokens snapshotted from the real app (one source, replaces per-mock OKLCH blocks)
    fixtures.js       # shared realistic fake data (window.RUNS/EVENTS/PUSHES)
  helix/              # migrated from "equin 2" (Helix)
    meta.json         # { name, blurb, theme, viewport }
    app.jsx           # defines window.App (global; no imports — Babel-in-browser)
    styles.css
  mist-panes/         # migrated from design/singularity (flush/float/soft explorations)
    meta.json
    app.jsx
    styles.css
```

- Each prototype is **standalone**: no CDN tags, no harness, no Stage/Compare/Root. Those move out (harness → `_shared`, Focus/Compare → the app).
- `harness.html` is served with `window.__PROTO_NAME__` injected by the server so `harness.js` knows which folder to load (the router has no wildcard/`import.meta` support — see §2).
- Migration: strip each existing mock down to `App` + styles; lift `RUNS`/`EVENTS`/`PUSHES` into `_shared/fixtures.js`; lift token blocks into `_shared/tokens.css`.

**Tooling exclusion (verified):** `tsconfig*.json`, `./equin check` (boundaries/docgen), and bun `workspaces` are all scoped to `plugins/` — repo-root `prototypes/` is invisible to them. Only safety net: add `"prototypes/**"` to the global `ignores` in `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` so a stray `bunx eslint prototypes/` is skipped rather than erroring.

### 2. Server: serve raw prototype files (`files` sub-plugin)

New sub-plugin `plugins/apps/plugins/prototypes/plugins/files/server/`. Raw `HttpHandler`s (NOT `implement()` — non-JSON, per-file Content-Type), mirroring `plugins/infra/plugins/asset-mirror/server/internal/handle-mirror.ts`:

- `GET /api/prototypes` → list: read every `prototypes/*/meta.json`, return `PrototypeMeta[]`.
- `GET /api/prototypes/:name?path=...` → raw file via `Bun.file()` → `new Response(file, { headers: { "content-type": mimeForExt(path) } })`. Default `path` = `_shared/harness.html` (with `__PROTO_NAME__` injected). Path-traversal guard: resolved abs path must stay under `join(REPO_ROOT, "prototypes")`.
  - The router has **no wildcard support** (segment-count-exact, `:param` only) → sub-paths go through the `?path=` query param, like `code-api`'s `getFileContent`.
- `REPO_ROOT` from `@plugins/infra/plugins/paths/server`; `PROTOTYPES_DIR = join(REPO_ROOT, "prototypes")`.
- Gateway forwards `/api/*` to the backend socket untouched; no CSP/`frame-ancestors` headers exist anywhere → iframe + CDN scripts load freely.

**Push-based reload** (no polling — git-watcher precedent, `plugins/infra/plugins/git-watcher/server/`):
- `defineResource` `prototypes.list` (loader = read all `meta.json`).
- `onReady`: `createFileWatcher({ dirs: [PROTOTYPES_DIR], extensions: [".jsx",".css",".html",".json"] })`; on change → `prototypesResource.notify()` and bump a `prototypes.version` resource (timestamp) so open iframes can cache-bust their `src`. `onShutdown`: stop watcher.

### 3. The Prototypes app

Follows `create-app` (top-level plugin is an empty namespace; content in sub-plugins) and mirrors the `story` app shape.

```
plugins/apps/plugins/prototypes/
  CLAUDE.md, package.json, web/index.ts          # empty namespace
  plugins/
    shell/    # Apps.App rail entry ({ id:"prototypes", icon: MdScience, path:"/prototypes", component: PrototypesLayout }); Pane.Register x2; AppShellLayout (no toolbar) wrapping <MillerColumns/>
    gallery/  # gallery root pane (segment:"", appPath:"/prototypes") + detail pane (segment:"p/:name")
    files/    # the server above (web barrel optional/empty)
```

- **Gallery pane** — `DataView` (`primitives/data-view`) `views={["gallery"]}` over `useResource(prototypesResource)`; card cover from `meta` (theme swatch + name + blurb); `onRowActivate` → `openPane(detailPane, { name })`. A "New prototype" card scaffolds a folder from `_shared` template (via a small server endpoint) — or, minimally, links to docs on adding one.
- **Detail pane** — `PaneChrome` containing:
  - A **Focus** view: the prototype in an `<iframe src="/api/prototypes/:name" sandbox="allow-scripts">`, scaled to fit via CSS `transform: scale()` (the old `Stage`, now app-side). Follow the `css` skill — container owns the scaling box; iframe is the rigid leaf.
  - A **Compare** toggle: render N prototypes' iframes side-by-side in a scaled grid (the old `Compare`, now app-side, with real live iframes).
  - iframe `src` carries the `prototypes.version` value as a cache-bust query so edits reload automatically.
  - An **"Improve this prototype"** button → existing `TaskDraftPopover` from `@plugins/tasks/plugins/task-draft-form/web`, pre-scoped: `title: "Improve prototype: <name>"`, description seeded with the path `prototypes/<name>/`. Agent edits files → watcher → iframe reloads. (No postMessage bridge.)

Each of the 4 new plugin dirs needs a `CLAUDE.md` (the `plugins-have-claudemd` check fails otherwise).

## Critical files

- Reference / copy: `plugins/infra/plugins/asset-mirror/server/internal/handle-mirror.ts` (raw file serving), `plugins/infra/plugins/git-watcher/server/internal/watcher.ts` (watcher→resource), `plugins/apps/plugins/story/plugins/shell/web/panes.tsx` (app panes), `plugins/apps/plugins/deploy/plugins/servers/web/` (DataView gallery + detail pattern).
- Reuse: `REPO_ROOT` from `@plugins/infra/plugins/paths/server`; `Apps.App` (`@plugins/apps/web`); `AppShellLayout`, `sidebarNavItem` (`@plugins/primitives/plugins/app-shell/web`); `Pane.define`/`Pane.Register`, `openPane` (`@plugins/primitives/plugins/pane/web`); `DataView` (`@plugins/primitives/plugins/data-view/web`); `useResource`/`defineResource` (`@plugins/primitives/plugins/live-state`); `createFileWatcher` (`@plugins/infra/plugins/file-watcher/server`); `TaskDraftPopover` (`@plugins/tasks/plugins/task-draft-form/web`).
- Edit: `plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts` (add `prototypes/**` ignore).
- New: `prototypes/` content dir; `plugins/apps/plugins/prototypes/**` (4 plugins).
- Migrate from (outside repo): `~/__A__/dev/design/equin 2/` and `~/__A__/dev/design/singularity/`.

## Out of scope (phase 2, later)

- Porting prototype ideas into real layout/framing **variants** (`variant-region`) and **theme** presets.
- A live in-iframe tweak bridge (sliders mutating tokens in real time) — would require building the postMessage protocol from scratch on both sides.
- Live-deriving `tokens.css` from the real theme-engine token groups (phase 1 uses a curated snapshot); self-hosting CDN libs via `asset-mirror` for offline.

## Verification

1. `./equin build`, then open `http://<worktree>.localhost:9000/prototypes`.
2. Gallery lists `helix` and `mist-panes`; open one → Focus shows the mock in a scaled iframe; Compare shows both side-by-side.
3. `./equin check` passes (boundaries, doc-in-sync, claudemd, registry-in-sync — commit regenerated `*.generated.ts`).
4. Push-reload: edit a value in `prototypes/helix/styles.css` → the open iframe reloads without manual refresh (watcher → version resource → cache-bust).
5. "Improve this prototype" opens the task-draft popover pre-filled with the prototype path.
6. Scripted check via `e2e/screenshot.mjs --url …/prototypes --click "Compare"` to confirm the Compare grid renders.
