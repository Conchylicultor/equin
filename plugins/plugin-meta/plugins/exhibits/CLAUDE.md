# exhibits

One catalog of **real components shown standalone**. A plugin exhibits one of
its own components from an `exhibits/` folder; every surface that wants to
render a component on its own — a gallery, the Prototypes canvas's Real app
frame, the layout-geometry harness — reads the same catalog.

## Contributing one

In the plugin that owns the component (never anywhere else), add
`exhibits/index.ts` whose default export is one exhibit or an array of them,
authored through a factory:

```ts
import { appExhibit, isolatedExhibit } from "@plugins/plugin-meta/plugins/exhibits/core";

export default [
  appExhibit({
    id: "task-draft/composer",        // `<group>/<name>`, globally unique
    label: "Task composer (Improve)",
    home: "chrome",                   // optional: where it lives (an AppRef, or "chrome")
    widths: [360, 480, 640, 900],     // optional for app exhibits
    load: () => import("./internal/composer"),
  }),
  isolatedExhibit({
    id: "grid/uniform-cards",
    label: "Uniform cards",
    widths: [320, 640],
    render: () => <Grid>…</Grid>,
    geometry: { dims, invariants },   // optional: the layout harness measures it
  }),
];
```

`exhibits` is a collected dir (`defineCollectedDir("exhibits")` in
`core/collected.ts`): codegen emits `core/exhibits.generated.ts` from the
filesystem, so a new contributor needs no registry edit.

## The three arms (`Exhibit["runtime"]`)

- **`isolated`** — renders anywhere, including the bare measurer page with no
  plugin runtime. The only arm that can carry `geometry` (`GeometrySpec`, from
  `primitives/css/layout-harness/geometry`).
- **`isolated-region`** — the same, but `render(children)` renders a HOLE the
  consumer fills (the harness passes its region kit; `<ExhibitView>` passes
  neutral text rows). Successor of the harness's `RegionFixture`.
- **`app`** — needs the live app (slots, config, data). Its component is behind
  `load()`, so reading the catalog evaluates no app-runtime code. `appExhibit`
  takes `geometry?: never`: passing one is a tsc error.

The group is the id's prefix (`exhibitGroupOf`).

## The contract every exhibit meets

- **Standalone.** Renders at any width with no ancestor but the app itself.
- **Self-contained state**, seeded from the same defaults the real host uses.
- **An exhibit, not a working copy.** Never submits, navigates, or writes to
  the database. Typing into it is fine; filing a task from it is not.

## Reading the catalog

- `loadExhibits()` (core) — every exhibit. Strict: a contribution that throws,
  exports nothing or exports a malformed item fails the whole load, naming every
  broken plugin. Not de-duplicated, so a clash stays visible.
- `lookupExhibit(all, id)` (core) — `found` | `missing` | `ambiguous`.
  `missing` is ordinary for ids from outside the repo (a prototype naming an
  exhibit that only exists on another branch).
- `useExhibits()` / `useExhibit(id)` (web) — the same, plus a `loading` arm:
  the catalog loads once per page. A failed load throws into the caller's error
  boundary.
- `<ExhibitView exhibit width?/>` (web) — renders any arm inside its own
  `PluginErrorBoundary`, at exactly `width` px when given.

## Why `exhibits/` is co-built with `web/`

An exhibit renders its plugin's PRIVATE components, so `exhibits/` may
deep-import its own `web/` (`../../web/components/composer`) — the one deep
own-folder import `runtime-isolation/no-deep-own-folder-import` allows. That is
sound only because `exhibits/` is not an artifact of its own: web-artifacts
builds it as a second entry of the plugin's web artifact (`COBUILT_FOLDERS` in
`web-artifacts/core/own-roots.ts`), so `exhibits.js` and `index.js` share one
instance of every web module (slots, contexts, stores). The import map serves
`@plugins/<p>/exhibits` from that artifact's `exhibits.js`, which is reached
only through the registry's dynamic import — never in the boot preload set. A
plugin with `exhibits/` and no `web/` fails the build.

## Who reads it

- The Prototypes canvas's Real app frame: `exhibit:<id>` in a prototype's
  `<meta name="mocks">` (`apps/prototypes/compare/exhibit`).
- The layout-geometry harness: `isolated` exhibits that carry `geometry`, plus
  region exhibits.
- **Debug → Exhibits** (`web/components/exhibits-pane.tsx`, this plugin): two
  Miller panes. The list (`exhibits-list.tsx`) is a DataView over the catalog
  (`plugin-meta.exhibits.catalog`: search, group by id prefix, filter by
  runtime / geometry) that renders no exhibit. A row opens the viewer
  (`exhibit-detail.tsx`) at `/debug/exhibits/x/<group>/<name>;theme=<app>`:
  that one exhibit at each of its widths (an app exhibit without widths at
  360 / 640 / 960), badged by runtime and `geometry`. It replaced the
  harness's Layout Lab, and the all-at-once gallery that followed it.

### Looking at one exhibit (agents)

```bash
./singularity run plugins/plugin-meta/plugins/exhibits/e2e/exhibit-shot.ts \
  --id task-draft/composer [--theme agent-manager|chrome] [--color-scheme dark]
```

It opens the viewer pane by URL and screenshots the frames element
(`[data-exhibit-frames]`) — no scrolling, no hunting. Ids:
`rg -n 'id: "' -g '**/exhibits/**' plugins`.

### Which theme an exhibit wears

A pane wears its home app's theme (`paneThemeScope`), so before the viewer
every exhibit silently wore **Debug's** theme, wherever the component lives.
The viewer wraps all frames in ONE explicit `<Theme name surface="canvas">`
boundary picked from the Theme select — any installed app (`app:<id>`) or the
app chrome's fixed theme (`chrome`) — and the pick rides the URL (`;theme`), so
a link or a screenshot names the theme it shows.

With no pick, the frames wear the exhibit's **`home`**: where the component
really lives, declared on the exhibit as data — an app's `defineApp` ref
(`home: agentManagerApp`, never a restated id) or `"chrome"` for what the app
chrome opens (the Improve popover). An exhibit without one lives in no one app
(a primitive) and opens in Debug's theme. The list's Home column shows it.

The catalog replaced two predecessors — layout-harness `fixtures/` folders and
the `Specimens.Specimen` dispatch slot — so there is one id namespace for both.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: Exhibit catalog: a plugin shows one of its REAL components standalone from an exhibits/ folder (isolatedExhibit / regionExhibit / appExhibit), collected into one generated registry. useExhibits() / useExhibit(id) answer loading / found / missing / ambiguous; <ExhibitView exhibit width?/> renders any arm inside its own error boundary. Debug → Exhibits lists the catalog as a DataView (searchable, grouped by id prefix, badged by runtime and geometry); a row opens the viewer pane (/debug/exhibits/x/<id>;theme=<app>) rendering that one exhibit at each of its widths inside an explicit, switchable theme boundary.
- Web:
  - Slots:
    - `exhibits.actions`
    - `exhibit.actions`
  - Slot contributors:
    - `exhibits.actions` ← `primitives.pane`
    - `exhibit.actions` ← `primitives.pane`
  - Contributes:
    - `Pane.Register` "exhibit"
    - `Pane.Register` "exhibits"
    - `DebugApp.Sidebar` "Exhibits"
  - Uses: 28 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `primitives/css/ui-kit` ×6
    - `primitives/pane` ×4
    - `primitives/data-view` ×3
    - `primitives/css/badge` ×2
    - `primitives/css/spacing` ×2
    - `apps-core/chrome-theme.chromeThemeScope`
    - `apps-core.Apps`
    - `apps/debug/shell.DebugApp`
    - `primitives/copy-to-clipboard.CopyButton`
    - `primitives/css/card.Card`
    - `primitives/css/scroll.Scroll`
    - `primitives/css/text.Text`
    - `primitives/css/theme-boundary.Theme`
    - `primitives/error-boundary.PluginErrorBoundary`
    - `primitives/live-state.useQueryResource`
    - `primitives/loading.Loading`
  - Exports (types):
    - `ExhibitResult`
    - `ExhibitsResult`
  - Exports (values):
    - `ExhibitView`
    - `useExhibit`
    - `useExhibits`
- Core:
  - Uses:
    - `framework/tooling/collected-dir.defineCollectedDir`
    - `framework/tooling/collected-dir.loadCollectedDir`
  - Exports (types):
    - `AppExhibit`
    - `AppExhibitSpec`
    - `Exhibit`
    - `ExhibitHome`
    - `ExhibitLookup`
    - `ExhibitRuntime`
    - `ExhibitWidths`
    - `IsolatedExhibit`
    - `RegionExhibit`
  - Exports (values):
    - `appExhibit`
    - `exhibitGroupOf`
    - `exhibitsCollectedDir`
    - `isExhibit`
    - `isolatedExhibit`
    - `loadExhibits`
    - `lookupExhibit`
    - `regionExhibit`
- Cross-plugin:
  - Uses tokens: `ui/tokens/shape --spacing`
  - Imported by: `apps/prototypes/compare/exhibit`

<!-- AUTOGENERATED:END -->
