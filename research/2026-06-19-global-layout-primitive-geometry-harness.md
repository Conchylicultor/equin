# Layout-primitive state-matrix geometry harness

## Context

Layout regressions in this repo are caught only by eyeball, which is why the
row-overlap bug class kept reopening — the canonical case being the
`CollapsibleCard` header's badge-over-file-path overlap (~11px, commit
`cb380efe6`), structurally fixed by the `Frame` grid primitive (`7239a2b08`),
then re-fixed for the no-meta centering regression (`5de46c6df`), the
TruncatingText silent-inline no-op (`d52c5806e`), and the menu-indicator shapes
(`97f285384`). Each fix shipped a *bespoke* geometry test
(`frame/web/internal/frame-geometry.test.ts`,
`truncating-text/web/internal/truncating-text-geometry.test.ts`) that
hand-rebuilds the primitive's DOM with inlined CSS and is **run by nobody
automatically** — there is no gate, so the next primitive's overlap is
undefended until someone notices it visually.

This plan standardizes one harness: a **declarative fixtures catalog** spanning
all layout primitives, tagged with a state matrix (content-length ×
metadata-presence × state × container-width), rendered with the **real React
components and real Tailwind**, measured by a **generic geometry oracle** that
asserts invariants (no track collision, no clip, strict-priority truncation
onset), and **wired into `./equin check`** (the only "CI" — there is no
GitHub CI) so any reappearing overlap fails the gate. The same catalog doubles
as a live in-app **Layout Lab** gallery so humans eyeball exactly what the gate
measures.

### Decisions (confirmed with the user)

- **Render fidelity:** real-component Vite build (faithful for *every*
  primitive — Overlay/Pin/Row/menu-indicators have no pure template function to
  share), not the hermetic hand-rebuilt-DOM approach.
- **Gate semantics:** geometry **invariants only** (overlap ≤ ε, ordering,
  truncation-onset ordering, no-clip + per-fixture falsification). No golden
  absolute-pixel snapshots — those flake across OS/font stacks. "Pixel
  regression" ≡ any track collision reappearing.
- **Live gallery:** the catalog is also surfaced as a Layout Lab pane.

## Architecture: one catalog source, three consumers, generic collection

A fixture is pure data + a `render: () => ReactElement`. It is consumed by three
runtimes:

1. the **geometry `bun:test`** (plain Bun + Playwright) — imports the catalog
   metadata (ids/widths/invariants) and drives the built page;
2. the **contributed check** (plain Bun) — shells out to (1);
3. the **live gallery** (React app runtime) — renders the catalog.

Per the **collection-consumer separation** rule, each primitive *contributes*
its own fixtures and all consumers read them **generically**. React slots
(`useContributions`) only work in consumer 3, so we collect the
**`collected-dir` way** (the same build-time codegen registry that powers
`check`/`lint`/`facet`) — which is **auto-discovered**: declaring
`defineCollectedDir("fixtures")` makes codegen emit `fixtures.generated.ts` with
**zero codegen edits** (verified: `codegen/core/plugin-registry-gen.ts`
`discoverCollectedDirs` AUTO-GROWS; `collected-dir/CLAUDE.md`). All three
consumers import that one generated registry via `loadCollectedDir`.

Each primitive drops `plugins/.../<primitive>/fixtures/index.ts` (default-export
`LayoutFixture[]`), exactly mirroring how each check is `<plugin>/check/index.ts`.
Importing a fixture module in Bun is safe (JSX compiles to uninvoked `jsx(...)`
calls; the `app.css` import lives only in the Vite entry, never in a fixture),
so the test can enumerate metadata in Node while the *rendering* happens in
Chromium via the bundle.

## Plugin tree to create

Umbrella sub-plugin of `css` (it is cross-cutting over all css primitives and
co-located with the lint gate it complements):

```
plugins/primitives/plugins/css/plugins/layout-harness/
  CLAUDE.md
  core/                          # runtime-agnostic: types + pure oracle + registry marker
    index.ts                     # barrel
    types.ts                     # LayoutFixture, FixtureDims, GeometryInvariant, MeasuredBox/Fixture
    oracle.ts                    # evaluateInvariant() + one pure fn per invariant kind (NO playwright)
    oracle.test.ts               # bun:test, pure — oracle fns on synthetic boxes
    collected.ts                 # defineCollectedDir("fixtures")  ← auto-discovered by codegen
    load-fixtures.ts             # loadFixtures() over fixtures.generated.ts
    fixtures.generated.ts        # CODEGEN OUTPUT (committed, like check.generated.ts)
  web/
    index.ts                     # barrel: Layout Lab pane + sidebar registration
    internal/
      build-fixtures-page.ts     # programmatic `vite build` (react + tailwind) → temp dir
      entry.html                 # vite entry; base "./"
      entry.tsx                  # imports app.css; exposes window.__renderFixture(id,width,falsify) + __measure()
      measure-page.ts            # Playwright driver → MeasuredFixture per (fixture,width)
      gallery.tsx                # Layout Lab gallery component (renders catalog × widths)
      lab-pane.ts                # Pane.define
  test/
    layout-geometry.test.ts      # THE generic suite: build page once, sweep catalog, evaluateInvariant
  check/
    index.ts                     # contributed Check, subtree-hash gated

# per-primitive contributions (one folder each, mirrors check/):
plugins/primitives/plugins/css/plugins/frame/fixtures/index.ts
plugins/primitives/plugins/css/plugins/truncating-text/fixtures/index.ts
plugins/primitives/plugins/css/plugins/pin/fixtures/index.ts
plugins/primitives/plugins/css/plugins/overlay/fixtures/index.ts
... (seeded set below; all primitives over time)
```

`core` holds the **pure oracle + types** (importable by Bun test and any web
code); `web` holds the **measure/build/gallery** (React + Playwright + Vite).
The bun:test imports `core` and drives the *built page* — it never pulls the
React runtime in-process.

> Wiring note: the new `fixtures/` contributor dir must be added to the
> collected-dir tsconfig/boundary coverage the same way `check/` is (the
> `collected-dir-tsconfig-coverage` check enforces this). Mirror the existing
> `check`/`lint` entries in `boundary-config.ts` / tsconfig globs.

## The fixtures contribution API (`core/types.ts`)

```ts
export type FixtureState = "idle" | "running" | "error";
export interface FixtureDims { contentLen: "short" | "long"; withMeta: boolean; state: FixtureState }

export type MeasuredBox = { left:number; right:number; top:number; bottom:number; width:number; height:number };
export interface MeasuredFixture {
  container: MeasuredBox;
  slots: Record<string, { box: MeasuredBox; truncates: boolean }>; // keyed by data-geo id
  order: string[];                                                  // DOM order of slot ids
}

export type GeometryInvariant =
  | { kind: "noOverlap"; epsilon?: number }
  | { kind: "noClip"; epsilon?: number }
  | { kind: "leftPack"; after: string; slot: string; gap: number }
  | { kind: "rigidIntegrity"; slot: string; epsilon?: number }      // width STABLE across sweep (measured, not magic px)
  | { kind: "pinnedRight"; slot: string; epsilon?: number }
  | { kind: "truncationOnsetOrder"; first: string; last: string }   // first ellipsizes at a WIDER width than last
  | { kind: "neverTruncatesWhenRoomy"; slots: string[] }
  | { kind: "falsification"; mutate: FixtureMutation; expectViolated: GeometryInvariant };

export type FixtureMutation =
  | { kind: "templateOverride"; value: string }     // force a wrong grid template
  | { kind: "swapLeafDisplay"; value: string };     // e.g. "inline" / "absolute-pad" — the known-broken construct

export interface LayoutFixture {
  id: string;            // "frame/header-badge-over-path"
  primitive: string;     // "frame"
  dims: FixtureDims;
  widths: number[];      // container widths to sweep (px)
  render: () => ReactElement;   // REAL component; author data-geo="<slot>" on measured boxes
  invariants: GeometryInvariant[];
}
```

**Slot identity is the `data-geo` contract**, authored by the fixture — the
oracle never references a primitive's internal class names, so it survives
refactors of the primitive's mechanics. `__measure()` reads
`[data-geo]` boxes + `scrollWidth>clientWidth` + DOM order.

### Example — Frame (the canonical victim), `frame/fixtures/index.ts`

```tsx
{
  id: "frame/header-badge-over-path",
  primitive: "frame",
  dims: { contentLen: "long", withMeta: true, state: "idle" },
  widths: [240, 360, 480, 720, 900],
  render: () => (
    <Frame
      leading={<span data-geo="leading"><Badge>main</Badge></span>}
      content={<span data-geo="content">Refactor the frame primitive layout</span>}
      meta={<span data-geo="meta">src/primitives/css/frame/web/internal/frame.tsx</span>}
      trailing={<span data-geo="trailing"><Badge>tool</Badge></span>}
    />
  ),
  invariants: [
    { kind: "noOverlap" }, { kind: "noClip" },
    { kind: "rigidIntegrity", slot: "leading" }, { kind: "rigidIntegrity", slot: "trailing" },
    { kind: "leftPack", after: "leading", slot: "content", gap: 8 },
    { kind: "pinnedRight", slot: "trailing" },
    { kind: "neverTruncatesWhenRoomy", slots: ["content", "meta"] },
    { kind: "truncationOnsetOrder", first: "meta", last: "content" },
    { kind: "falsification",
      mutate: { kind: "templateOverride", value: "auto minmax(0,3fr) minmax(0,1fr) auto" },
      expectViolated: { kind: "truncationOnsetOrder", first: "meta", last: "content" } },
  ],
}
```

This is *stronger* than the bespoke test: `rigidIntegrity` measures the **real**
`Badge` width and asserts it is stable across the sweep, instead of pinning the
magic `LEADING_W=40` of a hand-built replica.

### Example — menu-indicator overlap shape, `pin/fixtures/index.ts`

```tsx
{
  id: "pin/menu-indicator-over-label",
  primitive: "pin",
  dims: { contentLen: "long", withMeta: false, state: "idle" },
  widths: [120, 160, 200, 280],
  render: () => (
    <Frame
      leading={<span data-geo="leading">icon</span>}
      content={<span data-geo="content">a/very/long/menu/item/label/that/should/ellipsize</span>}
      trailing={<Pin to="top-right"><span data-geo="indicator">✓</span></Pin>}
    />
  ),
  invariants: [
    { kind: "noOverlap" }, { kind: "noClip" },
    { kind: "falsification",
      mutate: { kind: "swapLeafDisplay", value: "absolute-pad" },  // old reservation-padding shape
      expectViolated: { kind: "noOverlap" } },
  ],
}
```

## The generic oracle (`core/oracle.ts`)

Pure functions, one per invariant kind, each
`(measuredByWidth: Record<number, MeasuredFixture>) => { ok:true } | { ok:false; detail }`.
A single `evaluateInvariant(inv, measuredByWidth)` dispatcher. The suite calls it
per fixture-invariant and `expect(r.ok).toBe(true)`. Onset invariants
(`truncationOnsetOrder`, `neverTruncatesWhenRoomy`) read the full width sweep
(onset = widest width at which `slots[id].truncates` first turns true — mirrors
the existing `truncationThresholds`).

The two bespoke tests map onto this set exactly (no contract is lost):

| Bespoke assertion | Generic invariant |
| --- | --- |
| adjacent `cur.right ≤ next.left+ε` | `noOverlap` |
| slot inside container | `noClip` |
| `leading/trailing.width≈const` | `rigidIntegrity` (measured-stable) |
| `content.left≈leading.right+8` | `leftPack` |
| `trailing.right≈container.right` | `pinnedRight` |
| roomy: neither truncates | `neverTruncatesWhenRoomy` |
| `metaAt>contentAt` sweep | `truncationOnsetOrder` |
| weighted/naive wrong templates | `falsification` |
| TruncatingText leaf clamps + ellipsizes | `noClip` + onset present |
| plain-`inline` overflows | `falsification` (`swapLeafDisplay:"inline"`, `expectViolated:noClip`) |

## Real components + real Tailwind into Playwright

**Vite build to a temp static dir, loaded via `file://`** (reuses the repo's
`@vitejs/plugin-react` + `@tailwindcss/vite` + `@plugins` alias — the exact set
in `vitest.config.ts`). Chosen over `renderToStaticMarkup` + injected CSS
because there is no standalone compiled `app.css` artifact (Tailwind v4 is JIT
via the Vite plugin), so that path still needs a build yet loses fidelity.

- `build-fixtures-page.ts` runs `vite.build({ root: internal, plugins:[react(),tailwindcss()], resolve:{alias:{"@plugins":…}}, build:{ outDir: mkdtemp(), rollupOptions:{ input: entry.html }}, base:"./" })` and returns the `index.html` path. `entry.tsx` statically imports `app.css` + `loadFixtures()`, so every fixture's real component is bundled and Tailwind scans them (fixtures live under `plugins/`, already in app.css `@source`).
- **Width axis is driven by a styled wrapper, not viewport resize**: `entry.tsx` exposes `window.__renderFixture(id, width, falsify?)` → mounts `<div data-geo="container" style={{width}}><Fixture/></div>` inside a deterministic-font root; and `window.__measure()` → returns the `MeasuredFixture`. The suite re-renders via `page.evaluate` per (fixture,width) on one loaded page — no reload per width.
- `measure-page.ts`: one `chromium.launch()` + one `page` reused for the whole catalog (as the bespoke tests already do in `beforeAll/afterAll`).

## The contributed check (`check/index.ts`) + cheap-in-steady-state caching

Mirrors `data-migration-dml-only`: shell out via `Bun.spawn(["bun","test",
".../layout-harness/test/layout-geometry.test.ts"])`; non-zero exit →
`{ ok:false, message:<stderr tail>, hint:"A layout primitive geometry invariant
regressed — run `bun test …/layout-geometry.test.ts` to see which fixture/slot
collided." }`.

**Caching.** Implement `cacheSignature(): string` returning a hash over only the
inputs the suite depends on — `sha256(sorted git tree-SHAs of
plugins/primitives/plugins/css/plugins/** + layout-harness/** + ui-kit app.css)`
(cheap: `git ls-files -s <globs>`, no content reads). The runner keys a recorded
PASS on `treeHash + checkId + sha256(sig)` (`checks/core/runner.ts`), so identical
full-tree reruns (e.g. `push` reusing `build`) skip instantly. To also skip when
*only unrelated* code changed (the steady-state goal), the check keeps its **own
sidecar marker** under `~/.singularity/layout-lab-cache/<sig>.pass`: if present,
return `{ok:true}` **without launching Chromium**; else run the suite and write
the marker on pass. Net: unchanged css subtree ⇒ zero browser launches regardless
of unrelated edits. Fail loudly with a clear hint if
`chromium.executablePath()` is missing (don't auto-install — `postinstall` owns
that).

Run flow:
```
./equin check layout-geometry
  → sig = hash(css-subtree + harness + app.css)
  → cache.has(sig) ? ok (no Chromium)                          [steady state]
  → else bun test layout-geometry.test.ts
       → build-fixtures-page() → measure-page() per fixture×width
       → evaluateInvariant() per invariant ; on pass → cache.record(sig)
```

## Live Layout Lab gallery

A **Debug sub-pane** (mirrors `debug/plugins/profiling/web/index.ts`: a
`Pane.define` + a Debug sidebar nav item, e.g. `MdGridView` "Layout Lab"). Not a
new top-level app — it's a dev surface. It imports the **same** `loadFixtures()`
registry (React runtime can import it directly; no Playwright) and renders, per
primitive, a labeled section with one `<div style={{width}}>` column per
`fixture.widths`, each calling `fixture.render()`. ~80 lines, no measurement —
the human-eyeball complement to the gate.

## Migration of the two existing geometry tests

Migrate then delete (keeping them duplicates the oracle + re-introduces the
inlined-CSS infidelity), and do it **last**, after the harness is green on its
own new fixtures, so there is never a window with zero geometry coverage:

1. **Frame** → `frame/fixtures/index.ts` (full `{short,long}×{meta,no-meta}×widths`
   matrix + strict-priority + both falsifications). Delete
   `frame-geometry.test.ts`. **Keep** `frame-grid-template.test.ts` (pure
   template-string unit test, unrelated to geometry).
2. **TruncatingText** → `truncating-text/fixtures/index.ts` (block-parent clamp +
   `swapLeafDisplay:"inline"` falsification). Delete
   `truncating-text-geometry.test.ts`.
3. Point both primitives' `CLAUDE.md` "Tests" sections at the harness.

## Seeding list (overlap-prone set first; harness is generic for the rest)

1. `frame/header-badge-over-path` — the CollapsibleCard victim (migrated).
2. `truncating-text/block-parent-no-op` — silent-inline regression (migrated).
3. `pin/menu-indicator-over-label` — SelectItem/DropdownMenu indicator-over-label.
4. `overlay/control-in-unclipped-cell` — rigid `SegmentedControl` in a `flex-1`
   cell without `Clip` (second bug shape in the css skill).
5. `frame/data-view-filter-row`, `frame/commit-row-item` — the other
   `97f285384` victims.

All other primitives (Column, Row, Scroll, Clip, Cluster, Grid, Center, Sticky,
Stack/Inset, Inline, surface) get a `fixtures/index.ts` over time — each new one
**auto-appears** in the matrix, the gallery, and the gate with zero consumer
changes. Add new invariant kinds only when a primitive needs one (e.g. a
`verticalFillIntegrity` for Column).

## Risks / edge cases

- **Headless-Chromium font determinism.** Sub-pixel text width drifts across OS
  font stacks ⇒ truncation onset can shift a few px. Mitigations: (a) force a
  fixed `font: 14px monospace` on the measured `data-geo` root (the bespoke
  tests already do this); (b) assert **ordering + ε-tolerances**, never absolute
  pixels (the reason we chose invariants over golden snapshots); (c) `ε=0.5`. The
  gallery may use real fonts; only the measured suite forces monospace.
- **Tailwind scan coverage.** Fixtures are under `plugins/` (covered by app.css
  `@source`) and statically imported by `entry.tsx` via the generated registry;
  `tailwind-scan-covers-classes` fails loudly if a fixture authors an
  out-of-scope class.
- **Check runtime budget.** Cold run = one Vite build (~seconds) + one Chromium
  launch (~1–2s) + sub-second in-page sweep; steady state = zero (sig cache). One
  browser/page reused across all fixtures.
- **`file://` ESM.** Set `base:"./"` for relative asset URLs. Fallback: serve the
  out dir on a random port and `page.goto("http://localhost:<port>")` — prefer
  `file://` for zero processes.
- **Collected-dir wiring.** Adding `defineCollectedDir("fixtures")` is
  zero-codegen-edit (auto-discovered), but the new `fixtures/` contributor dir
  must be added to the collected-dir tsconfig/boundary coverage like `check/`
  (the `collected-dir-tsconfig-coverage` check enforces it).

## Verification (end-to-end)

1. `./equin build` — regenerates `fixtures.generated.ts` from the
   `defineCollectedDir("fixtures")` marker + the seeded `fixtures/index.ts` files;
   build must stay green (boundary, tsconfig-coverage, doc-in-sync checks).
2. `bun test plugins/primitives/plugins/css/plugins/layout-harness/test/layout-geometry.test.ts`
   — the seeded fixtures pass all invariants; the **falsification** cases must be
   reported as expected-violations (the oracle has teeth). Temporarily revert a
   primitive (e.g. give `Frame` a weighted `3fr/1fr` template) and confirm the
   suite goes red on `frame/header-badge-over-path`.
3. `bun test plugins/primitives/plugins/css/plugins/layout-harness/core/oracle.test.ts`
   — pure oracle unit tests on synthetic boxes pass.
4. `./equin check layout-geometry` — green; run it twice and confirm the
   second run short-circuits via the sig cache (no Chromium launch); touch a css
   primitive and confirm it re-runs.
5. Open `http://<worktree>.localhost:9000` → Debug → **Layout Lab**: every
   seeded fixture renders across its width columns; visually confirm no overlap
   at the narrow widths.

## Critical files

- `plugins/framework/plugins/tooling/plugins/checks/core/runner.ts` — `cacheSignature` + tree-hash key contract to mirror.
- `plugins/framework/plugins/tooling/core/types.ts` — the `Check` + `cacheSignature` interface.
- `plugins/framework/plugins/tooling/plugins/checks/plugins/data-migration-dml-only/check/index.ts` — `Bun.spawn` check pattern to mirror.
- `plugins/framework/plugins/tooling/plugins/collected-dir/{core/load-collected-dir.ts,CLAUDE.md}` + `codegen/core/plugin-registry-gen.ts` — the auto-discovered collection mechanism.
- `plugins/primitives/plugins/css/plugins/frame/web/internal/frame-geometry.test.ts` — the oracle to generalize + migrate.
- `plugins/primitives/plugins/css/plugins/scroll/web/internal/scroll.tsx` — example primitive exposing a pure class fn (`scrollClasses`).
- `vitest.config.ts` — the exact Vite plugin set + aliases `build-fixtures-page.ts` reproduces.
- `plugins/debug/plugins/profiling/web/index.ts` — the Debug-pane registration pattern for Layout Lab.
- `.claude/skills/css/SKILL.md` — the overlap bug-class taxonomy the fixtures encode.
```
