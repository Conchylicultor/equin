# One exhibit catalog: unify layout fixtures and specimens

## Context

Two mechanisms exist for "render one real component standalone":

| | `fixtures/` (layout-harness) | Specimens (`plugin-meta/specimens`) |
|---|---|---|
| Declared in | leaf folder `plugins/<p>/fixtures/index.ts`, collected by codegen (`defineCollectedDir("fixtures")` in `layout-harness/core/collected.ts` → `core/fixtures.generated.ts`) | `Specimens.Specimen` dispatch-slot contribution in the owner's `web/index.ts` |
| Shape | `id, primitive, dims, widths, render, invariants` (+ `RegionFixture`) | `match (id), label, description?, widths?, component` |
| Renders | bare Vite page, no plugin runtime (geometry measurer); also in-app (Layout Lab) | inside the running app only (real slots, config, live data) |
| Consumers | geometry bun:test + `layout-geometry` check, Layout Lab (Debug), prototypes `fixture:` kind | prototypes `component:` kind |
| Contributors | 9 plugins under `primitives/` (2 empty: `css/overlay`, `css/pin`) | 3 plugins, 6 specimens (`chart-kit`, `task-draft-form`, `config_v2/settings`) |

Problems: two catalogs/id namespaces/mocks kinds; specimen code statically imported by `web/index.ts`, so it ships **in the eager boot bundle** (none are lazy); Layout Lab cannot show specimens.

Outcome: **one `exhibits/` leaf folder, one generated registry, one catalog API**, with the isolated-vs-app distinction carried as a discriminated union in the entry type.

## Key finding that shapes the design: how an exhibit reaches private components

- `boundary-rules`: verdict depends only on (source folder, target folder); depth is never examined, so `fixtures/x.tsx → ../web/components/Bar` **passes** (`boundaries/core/evaluate.ts:72-94`, row `fixtures: ["web","core"]`).
- `plugin-boundaries`: R-rules only look at cross-plugin imports (R10 aside) — **passes**.
- **But** `runtime-isolation/no-deep-own-folder-import` (lint, `BROWSER_BUILT` includes `fixtures`) rejects it, and **web-artifacts throws at compose**: an import into an own non-inlined folder is rewritten to that folder's external barrel, deep paths refused ("one URL = one module instance"; `inlinedRootsFor(kind) = [kind, "shared"]` in `web-artifacts/core/own-roots.ts`). Inlining `web/` into the exhibit artifact is not an option either — it duplicates module instances (two copies of the plugin's slots/contexts), which breaks every app-runtime exhibit, and was the cause of a past fossilised-artifact outage.

**Decision: an exhibits folder is a private second entry of its own plugin's web artifact.** The web artifact is built multi-entry (`lib.entry: { index: web/index.ts, exhibits: exhibits/index.ts }`); rollup puts shared modules in common chunks, so `exhibits.js` and `index.js` share one instance of every web module. The import map maps `@plugins/<p>/exhibits` → that artifact's `exhibits.js`. Consequences:

- Exhibits deep-import their own `web/` internals relatively (`../../web/components/task-draft-composer`). No public barrel widens; no friend barrel.
- `exhibits.js` is reached only through the registry's dynamic `import()`, so it is never in the modulepreload closure (`compose.ts` seeds preload from static imports only) → **out of the eager boot bundle**.
- `inlinedRootsFor("web")` becomes `["web", "shared", "exhibits"]` — the one list both the address and content halves read, so an exhibit edit re-addresses the web artifact (correct; the audit `createInlineAudit` keeps guarding it).
- Every exhibit contributor must have a `web/` folder (all 12 do). Enforced loudly in the planner ("exhibits/ without web/").

## Design

### Folder vocabulary + boundaries
- `plugin-id/core/plugin-id.ts`: `LEAF_FOLDERS` replaces `fixtures` with **`exhibits`**. (`fixtures` is overloaded with test fixtures — e.g. `derived-updated-at/check/internal/fixtures/`, which the `layout-geometry` check's `isSeedPath` currently matches by accident.)
- `boundaries/core/boundary-config.ts`: row `exhibits: ["web", "core"]` (rename). Leaf → still never an import target.
- `lint/plugins/runtime-isolation/lint/no-deep-own-folder-import.ts`: `BROWSER_BUILT` swaps `fixtures`→`exhibits`; add the one exemption **`exhibits` → own `web` may be deep** (it is co-built). Every other own-folder deep import from `exhibits/` (e.g. `../core/x`) stays rejected.
- `web-artifacts`: `own-roots.ts` (web kind inlines `exhibits`), `vite-builder.ts` (multi-entry when `exhibits/index.ts` exists), `plan.ts` (no standalone `exhibits` artifact kind; map entry → web artifact's `exhibits.js`), doc invariant update in its CLAUDE.md.

### The catalog: rename `plugin-meta/specimens` → `plugin-meta/exhibits`
`core/` (Bun + browser safe):

```ts
interface ExhibitBase { id: string; label: string; description?: string }   // id "<group>/<name>", globally unique
type Exhibit =
  | (ExhibitBase & { runtime: "isolated"; widths: readonly [number, ...number[]];
       render: () => ReactElement; geometry?: GeometrySpec })               // renders anywhere, incl. bare page
  | (ExhibitBase & { runtime: "isolated-region"; widths: …;
       render: (children: ReactNode) => ReactElement })                     // today's RegionFixture
  | (ExhibitBase & { runtime: "app"; widths?: …;
       load: () => Promise<{ default: ComponentType }>; geometry?: never }); // needs the live app
```

- Authored through factories `isolatedExhibit()`, `regionExhibit()`, `appExhibit()` so a `geometry` on an app exhibit is a **tsc error** (no field to put it in).
- `GeometrySpec = { dims: FixtureDims; invariants: GeometryInvariant[] }`. These types (plus `FixtureMutation`, `HOST_MARKER_ATTR`) move from `layout-harness/core/types.ts` to a new types-only leaf **`primitives/css/plugins/layout-harness/plugins/geometry`** (core). Needed to avoid a cycle: catalog → geometry types; layout-harness → catalog + geometry.
- An app exhibit's component is behind `load()` so the bare measurer page and every metadata read never evaluate app-runtime code.
- `primitive` is dropped: group = id prefix (verified: every fixture's `primitive` equals its id prefix).
- `exhibitsCollectedDir = defineCollectedDir("exhibits")` → codegen emits `core/exhibits.generated.ts` (existing `plugin-registry-gen.ts` path; no new codegen). `loadExhibits()` = `loadCollectedDir(exhibitsEntries, { isItem, dedupeKey: e => e.id, label: "exhibit" })`. Duplicate ids: keep today's `lookupExhibit` → `found | missing | ambiguous` (port of `lookup.ts` + test).

`web/`:
- `useExhibits()` / `useExhibit(id)` → `{ kind: "loading" } | found | missing | ambiguous` (a loading arm is new: the catalog is now async).
- `<ExhibitView exhibit width?/>`: renders any arm (app arm via `lazy-component`), wrapped in `PluginErrorBoundary`.
- **Exhibits gallery** in Debug (replaces Layout Lab; moves from `layout-harness/web` to here, route `exhibits`): grouped by id prefix, each entry at each width, badge `isolated` / `app` / `geometry`. Shows specimens and fixtures alike.
- The `Specimens.Specimen` slot is deleted.

The contract (from specimens' CLAUDE.md) applies to every exhibit: **standalone, self-contained state seeded from the real host's defaults, never submits/navigates/writes.**

### layout-harness (consumer only)
- Drops `collected.ts`, `fixtures.generated.ts`, `load-fixtures.ts`, `lab-pane.tsx`, `gallery.tsx`, its `DebugApp.Sidebar`/`Pane.Register`.
- `expandRegionFixtures` → maps `isolated-region` exhibits to measurable entries (unchanged logic).
- Geometry suite + bare page (`entry.tsx`, `layout-geometry.test.ts`) read `loadExhibits()` filtered to `runtime === "isolated" && geometry` plus regions. App exhibits are skipped by construction.
- `check/index.ts`: seed paths `plugins/**/exhibits/**` (fixes the `isSeedPath` false match); contributor roots from `exhibits/`.

### Prototypes compare
- One counterpart component (`compare/plugins/exhibit`, replacing `plugins/fixture` and `plugins/component`) over `useExhibit(ref)`: `loading` / `unresolved` (missing, ambiguous) / `found` → `<ExhibitView>`, using the exhibit's widths.
- Canonical kind **`exhibit:`**; `fixture:` and `component:` registered as aliases of the same component so the 6 existing prototypes keep resolving on every branch (prototypes are shared across worktrees; main must understand both until it has the new code).
- After push: rewrite the 6 prototype tags (`_template`, `proto-1788886679-mpxw` = `fixture:control-panel/setting-rail`; `proto-1789665568-9onf`, `proto-1789901373-oy29`, `proto-1790933711-zbyx` = `component:…`) to `exhibit:…`, then file a task to drop the aliases.

### Migration of contributors (pattern)
- **Fixtures** (7 non-empty): `git mv plugins/<p>/fixtures plugins/<p>/exhibits`; wrap each entry in `isolatedExhibit({ id, label, widths, render, geometry: { dims, invariants } })` / `regionExhibit(...)`; add a `label`. Representative: `primitives/css/plugins/control-panel/exhibits/internal/control-panel-exhibits.tsx`. Delete the empty `css/overlay` and `css/pin` fixture folders.
- **Specimens** (6): move `*-specimen.tsx` out of `web/components/` into `exhibits/internal/`, imports rewritten to relative deep `../../web/...`; `exhibits/index.ts` exports `appExhibit({ id, label, description, widths, load: () => import("./internal/composer") })`; remove `Specimens.Specimen(...)` and its imports from the three `web/index.ts`. Keep ids (`task-draft/composer`, `task-draft/form`, `chart-kit/{time-chart,histogram,sparkline}`, `config/field-gallery`). Candidates for `isolated` instead of `app`: `chart-kit/*` (pure props) — classify each during migration by whether it renders on the bare page; default `app`.
- Files: `tasks/plugins/task-draft-form/web/components/{composer,form}-specimen.tsx`, `primitives/plugins/metrics/plugins/chart-kit/web/components/specimens.tsx`, `config_v2/plugins/settings/web/components/field-gallery-specimen.tsx`.

### Docs
Root `CLAUDE.md` (leaf folder list, folder-structure block, Driving-the-app compare paragraph), `prototypes/CLAUDE.md` (four metadata tags: `exhibit:` + aliases), `plugin-meta/plugins/exhibits/CLAUDE.md` (new: contract, arms, folder, why co-built), `layout-harness/CLAUDE.md` ("How fixtures are contributed" → exhibits with geometry), `web-artifacts/CLAUDE.md` (exhibits co-built invariant), `task-draft-form/CLAUDE.md` ("the two specimens"), `boundaries`/`runtime-isolation` docs where `fixtures` is named. Autogen blocks via `./equin build`.

## Order of work
1. geometry types leaf; catalog plugin rename + core types/factories/loader/lookup.
2. Folder vocabulary, boundary row, lint exemption, web-artifacts multi-entry + `own-roots` + plan.
3. Migrate fixtures → exhibits; layout-harness consumes the catalog.
4. Migrate specimens; delete the slot.
5. Gallery in Debug; prototypes `exhibit:` kind + aliases; delete old kinds.
6. Docs; build.

## Verification
- `./equin check` (boundary-rules, plugin-boundaries, type-check incl. lint, plugins-registry-in-sync, plugins-doc-in-sync, web-artifacts:map-in-sync, layout-geometry).
- `./equin test plugins/plugin-meta/plugins/exhibits plugins/primitives/plugins/css/plugins/layout-harness plugins/framework/plugins/tooling/plugins/web-artifacts`.
- Type-error probe: a scratch `appExhibit({ …, geometry })` fails tsc (remove after).
- `./equin build`; then confirm `exhibits.js` is absent from the boot modulepreload list in the built `index.html`, and present in the import map.
- Screenshot `--path /debug/exhibits` (gallery shows both kinds); `compare-diff.ts --name proto-1789901373-oy29` (`component:` alias) and `--name proto-1788886679-mpxw` (`fixture:` alias) both resolve to a found frame.

## Risks
- Multi-entry lib build in web-artifacts is the one genuinely new build mechanic; vite lib mode supports an entry object, but the import-clause/link verifier and `staged-verify` must learn that one artifact serves two specifiers.
- Catalog becomes async for the prototypes `component:` path (was synchronous slot lookup) — the counterpart gains a `loading` arm.
