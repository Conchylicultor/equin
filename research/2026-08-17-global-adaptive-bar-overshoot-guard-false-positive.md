# Layout Lab crashes: the adaptive bar's overshoot guard accuses the wrong box, and its remedy never stops

## Context

Opening **Debug → Layout Lab** renders nothing but a crash banner —
`layouts.miller / layout-lab crashed — Minified React error #185`
("Maximum update depth exceeded"). It reproduces on `main`
(`http://singularity.localhost:9000/debug/layout-lab`) and in a fresh worktree
with a from-scratch artifact rebuild, so it is current source. A report row
already exists in the main DB (`report-1786960015254-znyt5a`, `kind: crash`,
`source: react-boundary`, url `/debug/layout-lab`).

The Layout Lab is the human-eyeball half of the layout-geometry harness — the
one surface where a contributed fixture is looked at rather than measured. It
has been dead since `adaptive-bar` contributed its fixtures, and the geometry
gate never noticed.

### What is actually wrong (reproduced, not inferred)

I built the real `Gallery` component into a Vite page and drove it in headless
Chromium (dev mode, so `failLoudly` throws a readable message). The thrown
fault is the **overshoot** guard:

```
adaptive-bar (More controls): the fit says everything fits and the rendered row
still sticks out past its parent's content box, so the bar was never given the
slack its width reading assumes.
```

`overshootsParent()` in
[`plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx`](../plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx)
picks the box to compare against like this:

```ts
const parent = (root.offsetParent ?? root.parentElement) as HTMLElement | null;
```

`offsetParent` is the nearest **positioned** ancestor. That is a different
concept from "the row this bar is a cell of". The Lab renders each fixture once
per swept width as a fixed-width `Card` inside a horizontally scrolling strip,
so a bar's viewport-space right edge is far to the right of the pane box that
happens to be its `offsetParent`. Measured, with the guard's own arithmetic
alongside the honest comparison against `root.parentElement`:

| card | bar right | offsetParent right | guard says | true parent overshoot |
|---|---|---|---|---|
| 720px |  735 | 900 | no  | no |
| 560px | 1311 | 900 | **YES** | no |
| 440px | 1767 | 900 | **YES** | no |
| 320px | 2103 | 900 | **YES** | no |
| 220px | 2339 | 900 | **YES** | no |

Every swept width lays out correctly. The guard is simply comparing the bar
against a box it was never laid out in — any bar inside a scroller, or merely
offset from its positioned ancestor, is falsely accused.

### Why a false accusation kills the pane

The remedy is not terminal. On a converged pass `reconcile` sets
`passesRef.current = 0`, then the overshoot branch calls `commitFloor()`, which
calls `setPlacement(floor)` **and also** resets `passes.current = 0`. The
placement changed, so `reconcile`'s identity changes, so the
`useResizeObserver` layout effect re-runs synchronously, re-decides, converges
back to the same ideal (`assign` is deliberately current-state-independent
apart from pins and hysteresis), overshoots again, floors again — forever.
`MAX_PASSES` can never bite, because both the convergence branch and
`commitFloor` reset the counter it is counting. React hits its nested-update
limit and throws #185.

So there are two independent defects, and either one alone would have kept the
pane alive:

1. the guard asks the wrong element (false positive), and
2. the remedy for a fault can re-enter itself (a fault becomes a render loop
   instead of "one report plus a cramped row", which is what
   [`adaptive-bar/CLAUDE.md`](../plugins/primitives/plugins/adaptive-bar/CLAUDE.md)
   promises).

### Three things that kept it invisible

- **`adaptiveBarReportSink` has no consumer.** `defineReportSink` returns a
  silent no-op until something registers. Grep finds only the definition and
  the emit — so in prod every adaptive-bar fault is dropped, and the
  documented "files a report through `adaptiveBarReportSink` in prod" is not
  true. Every other web-side sink has a collector under
  `plugins/reports/plugins/<name>/`.
- **The geometry gate cannot see a crash.** `measure-page.ts` never listens for
  `pageerror`; the suite happily measures a tree React has torn down. And the
  measurer wraps each fixture in its own `position: relative` box, so it never
  reproduces the offset-from-positioned-ancestor shape the Lab has.
- **The gate's cache signature does not cover the primitive.** `SIG_GLOBS` in
  `layout-harness/check/index.ts` hashes `plugins/primitives/plugins/css/plugins/**`
  and `plugins/**/fixtures/**`. `adaptive-bar/web/**` is in neither, so an edit
  to the primitive the fixtures render leaves the marker valid and the check
  reports `ok (cached)`. The file's own comment describes exactly this hole for
  *fixtures* of a non-css contributor and then only half-closes it.

## Approach

Fix the accusation, make the remedy terminal, make the fault visible, and close
the detection gap — in that order of importance.

### 1. Ask the element, not its ancestors

Delete `overshootsParent()` (and its only helper, `px()`), and replace it with a
question the bar can answer about itself:

```ts
/** Did the row we just blessed actually fit the box the layout engine gave us? */
function rowOverflowsItsBox(root: HTMLElement): boolean {
  return root.scrollWidth > root.clientWidth + 1;
}
```

The bar root is `overflow-hidden` in `panel`/`clip` mode (`BAR_CLIP`), so
`scrollWidth > clientWidth` *is* "the content the fit blessed does not fit". No
ancestor, no positioning, no scroll offset, no padding/border arithmetic —
nothing to pick wrongly. The `+ 1` keeps the existing sub-pixel tolerance.

Gate it on `overflow !== "scroll"`: in scroll mode content overflow is the
intended behaviour, not a contradiction.

**What this trades away, stated honestly.** The old comparison nominally also
caught "an ancestor is shrink-to-content, so the width I read is not a width I
was given". It did not catch that soundly either (with a `w-fit` parent the bar
fills its parent exactly and the spill is the *grandparent*'s), and its unsound
half is what kills panes. Attribution of a shrink-to-content ancestor belongs to
the `no-slack` guard; a follow-up task will be filed noting that the `no-slack`
guard is also weaker than it reads (it tests `getComputedStyle(root).flexGrow`,
which returns the declared `1` regardless of whether any slack existed). Not in
scope here — soundness first.

### 2. Surrender is terminal

Add `surrenderedRef` to `AdaptiveBarShell`, set **inside** `commitFloor` so a
floor commit cannot be made without it:

- `commitFloor(...)` takes the ref and sets `surrendered.current = true`.
- `reconcile` keeps step 1 (apply the committed placement to the DOM: dock
  inline, dock the evicted group, maintain `hidden`) so items that mount or
  unmount afterwards are still placed correctly — then, immediately after that
  block and the `collapsed` early-return, `if (surrenderedRef.current) return;`
  before measuring or deciding.

Permanent for the mount, deliberately. The guard only fires when the bar's own
contract is broken; the floor is the one configuration that cannot overflow; a
report has been filed. Re-deriving from the same broken premise can only
reproduce the same fault, and the current alternative is a dead pane. Both fault
paths that floor (`overshoot`, `no-convergence`) become genuinely terminal.

`AdaptiveBarCollapsed` never measures, so it never floors and is unaffected.

### 3. Wire the sink into the reports pipeline

New plugin `plugins/reports/plugins/adaptive-bar/`, mirroring
`plugins/reports/plugins/optimistic-divergence/` byte-for-byte in shape:

- `core/adaptive-bar-kind.ts` + `core/index.ts` — zod payload
  `{ fault: "no-slack" | "overshoot" | "no-convergence" | "iframe-relocation",
  label: string, message: string }` and
  `adaptiveBarFingerprint = sha256(fault + "\0" + label).slice(0,16)`.
  `message` is excluded: it is a constant per fault kind, so including it buys
  nothing and would split rows if the wording is ever edited.
- `server/index.ts` — `ReportKind({ kind: "adaptive-bar", schema, fingerprint,
  meta: { tag: "[adaptive-bar]", notif: "Adaptive bar layout contract
  violated", variant: "warning", notifCooldownMs: 6h }, renderTask })`, with
  `server/internal/adaptive-bar-task.ts` rendering a per-fault title and a
  description that states the contract and the consumer-side fix.
  `notifCooldownMs` because a broken host keeps producing the fault on every
  mount — the same policy `optimistic-divergence` and `render-loop` use.
- `web/index.ts` — `Core.Root({ component: AdaptiveBarCollector })` registering
  `adaptiveBarReportSink` into `report({ kind: "adaptive-bar", source:
  "client-…", … })`, plus `Reports.KindView` for the one-line Debug → Reports
  summary.

The `source` value must come from `CLIENT_REPORT_SOURCES` in
`plugins/reports/core/sources.ts` — add one if none fits.

### 4. Make the geometry gate see a crash, and give it the shape that crashes

- **`web/internal/measure-page.ts`** — collect `page.on("pageerror")` (and
  `console` messages of type `error`) into an array on the `Measurer`, exposed
  as `takePageErrors(): string[]`.
- **`web/internal/layout-geometry.test.ts`** — one top-level test draining
  errors after the page loads, and one per-fixture test draining after that
  fixture's sweep. Both throw with the literal prefix
  `fixture page error:` so the failure is attributable.
- **`check/classify.ts`** — add `/fixture page error:/` to `FATAL_SIGNATURES`
  (before the environmental pass, which it already is), and extend
  `check/index.test.ts` accordingly. A crashed fixture must never be filed as
  an environmental timeout.
- **New fixture `adaptive-bar/offset-from-positioned-ancestor`** in
  `plugins/primitives/plugins/adaptive-bar/fixtures/internal/adaptive-bar-fixtures.tsx`:
  a bar inside a horizontally scrolling strip behind a wide filler, so its
  viewport rect lies well outside the harness's `position: relative` wrapper —
  the Layout Lab's shape, reduced. It authors its **own** inner
  `[data-geo="container"]` around the bar's card (the measurer prefers the
  innermost one), so `noClip`/`noOverlap` are judged against the card and not
  against the scroll viewport the filler deliberately overruns.
  Reverting fix (1) must make this fixture fail the gate — that is the
  regression proof, and it will be verified by actually reverting.
- **`check/index.ts` `SIG_GLOBS`** — derive each fixture contributor's plugin
  root from the `plugins/**/fixtures/**` matches and hash that whole subtree,
  instead of hashing only the fixtures folder. Today an edit to
  `adaptive-bar/web/**` leaves the marker valid, which is how a change to the
  primitive under test can ship without the gate ever re-running.

### 5. Contain a crashing fixture to its own card

`gallery.tsx` renders arbitrary contributed fixtures; one of them throwing
currently takes the whole Lab down. Wrap each fixture card in the error-boundary
primitive (`plugins/primitives/plugins/error-boundary/web` — use whichever of
`PluginErrorBoundary` / `ErrorBoundary` is the sanctioned non-slot entry) so a
bad fixture shows a crash card in its own cell and the rest of the catalog stays
readable.

### 6. Tests

- **jsdom, `adaptive-bar/web/__tests__/termination.test.tsx`** (new) — the
  termination invariant, which needs no layout engine. Drive
  `AdaptiveBarMeasure` with a width fake that oscillates for a given (item,
  rung) so the placement cannot converge, forcing the `no-convergence` floor,
  then assert the bar stops re-deciding (bounded render/measure count) rather
  than looping. Today this hangs or blows the update depth; after the fix it
  settles. Same harness shape as
  `web/__tests__/relocation.test.tsx` (`measureFake`, module-level `WIDTHS` /
  `available`).
- **browser** — the new fixture above, through
  `./equin check layout-geometry`.
- No `core/` test: none of this is fit math.

### 7. Docs

- `adaptive-bar/CLAUDE.md` — the "Break the rule and you get told" paragraph
  describes the removed comparison and the non-terminal remedy; rewrite it to
  state what the guard now measures, that a floored bar is *done deciding for
  that mount*, and that the report reaches Debug → Reports.
- `layout-harness/CLAUDE.md` — the gate now fails on a page error, the
  signature covers fixture contributors' whole plugin subtrees, and the gallery
  contains crashes per card.
- Both plugins' autogen reference blocks are regenerated by `./equin build`.

## Files

| file | change |
|---|---|
| `plugins/primitives/plugins/adaptive-bar/web/internal/adaptive-bar.tsx` | replace `overshootsParent`/`px` with `rowOverflowsItsBox`; add `surrenderedRef`, set it inside `commitFloor`, early-return in `reconcile` |
| `plugins/primitives/plugins/adaptive-bar/web/internal/diagnostics.ts` | reword the `overshoot` fault message |
| `plugins/primitives/plugins/adaptive-bar/fixtures/internal/adaptive-bar-fixtures.tsx` | new offset-from-positioned-ancestor fixture |
| `plugins/primitives/plugins/adaptive-bar/web/__tests__/termination.test.tsx` | new |
| `plugins/reports/plugins/adaptive-bar/{core,server,web}/**` | new plugin (report kind + collector + KindView) |
| `plugins/reports/core/sources.ts` | new client source if needed |
| `plugins/primitives/plugins/css/plugins/layout-harness/web/internal/measure-page.ts` | capture page errors |
| `…/layout-harness/web/internal/layout-geometry.test.ts` | assert no page errors |
| `…/layout-harness/check/classify.ts` + `check/index.test.ts` | `fixture page error:` is fatal |
| `…/layout-harness/check/index.ts` | signature covers fixture contributors' plugin roots |
| `…/layout-harness/web/internal/gallery.tsx` | per-card error boundary |
| the two `CLAUDE.md`s above | prose corrections |

## Verification

1. `./equin test plugins/primitives/plugins/adaptive-bar` — the new
   termination test plus the existing relocation/keepalive suites.
2. `./equin check layout-geometry` — must pass with the new fixture; then
   temporarily revert the `rowOverflowsItsBox` change and confirm it **fails**
   with a `fixture page error:` (classified fatal), then restore.
3. `./equin check` — full gate (boundaries, type-check, doc/registry sync).
4. `./equin build`, then drive the real pane:
   `bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts
   --url http://<worktree>.localhost:9000/debug/layout-lab --out /tmp/lab` —
   the gallery renders every fixture at every swept width, no crash banner.
5. `query_db` on the worktree: no new `kind = 'adaptive-bar'` report rows from
   the healthy Lab. Then confirm the wiring end to end by pointing a throwaway
   bar at a `w-fit` parent (or temporarily forcing the fault) and checking the
   row appears in Debug → Reports with the right tag.

## Out of scope (follow-ups to file)

- The `no-slack` guard's `getComputedStyle(root).flexGrow === "0"` test does not
  detect "no slack" — it reads the declared value, so a bar inside a
  shrink-to-content or non-flex parent passes it. A real detector needs a
  different signal.
- `putLadder` stores a fresh `Required<ShrinkLadder>` object on every
  re-declaration, so re-declaring costs a `ladders` state change and a bar-wide
  re-render even when the ladder's value is unchanged. Value-compare instead.
- The `git-diff`/`sed` PreToolUse guard flagged a `sed` script as a write to the
  main checkout because the expression contained `".."`; it parses sed scripts
  as paths.
