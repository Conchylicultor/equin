# Web

The SPA composition root. This plugin is **only** bootstrap — it owns the React
entry point and the HTML shell the frontend build composes from, and nothing
else. (The build itself is owned by
[`framework/tooling/web-artifacts`](../tooling/plugins/web-artifacts/CLAUDE.md);
no build config lives here any more.) No SSR, no SEO concerns.

The foundational UI layer (the `cn()` util, the shadcn/ui primitives, the global
`theme/app.css` stylesheet, and the `ControlSize` affordance-sizing context) used
to live here behind an ambient `@/*` alias. It now lives in its own boundary-legal
plugin, [`primitives/ui-kit`](../../../primitives/plugins/css/plugins/ui-kit/CLAUDE.md);
consumers import `@plugins/primitives/plugins/css/plugins/ui-kit/web`. The `@/*` alias has been
deleted, so a stray `@/` import is now an unresolved-module error at build time.

## Stack

- **Vite** — the underlying bundler, driven programmatically per plugin by the
  web-artifacts pipeline (no `vite.config.ts` lives here)
- **React 19** + **TypeScript**
- **Tailwind CSS v4** — `@tailwindcss/vite` plugin; the global stylesheet
  (`app.css`) lives in `primitives/ui-kit` and is imported from `web/main.tsx`.
- **Material Symbols** — Icons, as `symbol("…")` data drawn by `<Icon>` from inline SVG sprites (`ui/icons`); not Lucide, not react-icons (saved icons are runtime symbols)

## Structure

- `web/` — SPA bootstrap only
  - `App.tsx` / `main.tsx` / `index.html` — the React entry + plugin loader
  - `components/plugin-load-errors.tsx` — boot-error surface
  - `boot-tasks.ts` — runs the `Core.Boot` tasks under one deadline
    (`BOOT_TASK_DEADLINE_MS`), tracking each task's status; never aborts one, so
    a late answer still boots the app
  - `components/boot-screen.tsx` — what `App` renders until boot is done (it
    has no `null` state): `waiting` (pending task labels + elapsed, faded in
    after a 1s grace so a normal boot never shows it), `stuck` (a `block` task
    past the deadline) or `failed` (one rejected), with Retry / Continue anyway.
    A failed / overdue task also files a `client-boot-task` report.
    `data-boot-state` is the e2e hook (`infra/boot-snapshot/e2e/boot-stall.ts`).
  - `__tests__/` — render smoke tests
  - `public/` — static assets

## Commands

Always go through `./singularity build` from the repo root.

### The frontend build

`./singularity build` composes the frontend as **per-plugin web artifacts**, and
that is now the only mode — the monolithic Vite build (and with it
`vite.config.ts`, `--monolith`, `--artifacts`, `SINGULARITY_WEB_MONOLITH`,
`SINGULARITY_WEB_ARTIFACTS`) was removed once release builds moved onto the same
pipeline. This plugin therefore carries no build config of its own; it is the
source root (`web/index.html`, `web/main.tsx`, `web/public/`) the pipeline
composes from.

Each plugin's `web/` barrel (plus every statically or dynamically imported folder
barrel — `core`, `prewarm`, …) builds into an independent, content-addressed
ES-module artifact; the browser composes them via an inline import map in
`dist/index.html`. Only changed plugins rebuild (typical warm step: a few
seconds). Artifacts are stored in `~/.singularity/cache/web-artifacts/` (`store/`
per-plugin artifacts, `vendors/` npm pre-bundles, `css/` cached global Tailwind
passes, `fingerprints/` stat caches), shared across all worktrees, pruned by age.
A **served** dist symlinks into that store; a **release** dist is composed with
`materialize: true`, so its `artifacts/` are real copies and the bundle is
self-contained. Guarded by the `web-artifacts:map-in-sync` and
`web-artifacts:no-vendored-state-inlined` checks; engine lives in
[`framework/tooling/web-artifacts`](../tooling/plugins/web-artifacts/CLAUDE.md).
`--no-minify` skips esbuild minification for debugging (hash input).

### Eager boot bytes

The frontend boot cost is dominated by the **eager set**. In artifact mode that
set is exactly the entry artifact plus the eager tier's `modulepreload` closure —
computed by `computePreloadClosure` in web-artifacts' `core/internal/compose.ts`
and written into `dist/index.html` as `<link rel="modulepreload">` tags, seeded
from the entry, the registry, and every non-deferred web target. That closure IS
the lever: moving a plugin into the deferred tier is what removes its bytes from
boot.

To see what a boot actually costs:

```bash
# the eager URL set of a deployed dist
grep -oE '(src|href)="/artifacts/[^"]*"' ~/.singularity/worktrees/<name>/web/index.html
```

- **Debug → Boot Profile** — the request → first-paint timeline with the
  per-resource wait/work split, plus a browsable list of saved snapshots.
- The **`client-boot` trace lane** on a slow page-load trace
  (`plugins/debug/plugins/trace/plugins/client-boot/`) carries the per-asset
  rollup: what the browser actually fetched, and how much of it was trimmed.

**There is no treemap.** The `VITE_ANALYZE` / `rollup-plugin-visualizer` report
died with the monolith and has no artifact-mode equivalent — chunk composition is
not a meaningful question when each plugin is its own artifact. The two surfaces
above measure real loads instead of predicted ones; nothing reconstructs the
"what is inside this chunk" view.

**Never ship an icon package.** A namespace import of `react-icons/md`
(`mdModule[key]`) once dragged the whole ~2 MB set onto the eager boot path
(**417 KB gzip = 62 % of the entry chunk**). Icons are now data: Material
Symbols names drawn by `<Icon>` from inline sprites holding only the names in
use (`ui/icons`), and saved (user-picked) icons are runtime symbols fetched per
visible name. react-icons is uninstalled; `icon-safety/no-react-icons` keeps it
out.

The eager-cost surfaces for this are the **Debug → Boot Profile** pane (the
request→first-paint *timeline*), the Boot Gantt, and the `client-boot` trace
lane's per-asset rollup.

### Tests

The vitest DOM suites here (`web/__tests__/`) need the browser stack (jsdom + the `@plugins` alias + `.css` imports + React rendering), which `bun:test` can't provide. They are discovered and run by the **repo-wide** vitest project (root `vitest.config.ts` + `test/setup.ts`), not a per-plugin config — see the root `CLAUDE.md` Testing section. One suite lives here: `plugin-render.test.tsx` (full plugin-graph load smoke).

`plugin-render.test.tsx` is a **load-only smoke**: it asserts `loadPlugins(webEntries)` returns zero errors and every contribution is structurally well-formed. It does not render contributions — a contribution needs its slot's props/context, so bare rendering is meaningless. Run from the repo root (optional):

```bash
bun run test:dom                                                              # whole DOM suite
bun run test:dom plugins/framework/plugins/web-core/web/__tests__/plugin-render.test.tsx   # one file
```

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Web:
  - Uses:
    - `primitives/css/center.Center`
    - `primitives/css/spacing.Stack`
    - `primitives/css/text.Text`
    - `primitives/css/ui-kit`
    - `primitives/css/ui-kit.Button`
    - `primitives/error-boundary.PluginErrorBoundary`
    - `primitives/live-state.ensureNotificationsClient`
    - `primitives/live-state.NotificationsProvider`
    - `primitives/perfs/boot-trace.markBootInstant`
    - `primitives/perfs/boot-trace.markBootInstantAtNextCommit`
    - `primitives/perfs/boot-trace.startBootSpan`
    - `primitives/perfs/boot-trace.traceBootPluginLoad`
    - `primitives/perfs/scheduler.yieldToMain`
    - `primitives/relative-time.ElapsedTime`
    - `reports.report`
- Cross-plugin:
  - Imported by: `framework/tooling/web-artifacts`
- Exemptions:
  - Exempts itself from: `plugin-boundaries` — `web/__tests__/plugin-render.test.tsx` (sanctioned)
- Core:
  - Exports (types):
    - `BabelPluginItem`
    - `OrderedBabelContribution`
    - `ViteContributionReturn`
  - Exports (values):
    - `findViteContributions`
    - `loadBabelContributions`
- Structure:
  - Composition root: yes

<!-- AUTOGENERATED:END -->
