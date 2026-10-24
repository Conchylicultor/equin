# OverlayPanel — one panel behind every floating surface

## Context

The page editor's "Turn into" block menu renders taller than the viewport, so its
bottom items are unreachable. It is an `InlinePopover` → `PopoverContent`, and
`PopoverContent` is the only floating surface in the kit with **no height clamp at
all** — no `max-h-(--available-height)`, no `overflow-y-auto`.

That is one cell of a wider matrix. Five surfaces each re-derive the same panel —
paint, geometry, animation, viewport fit, and the content-context wrappers — and no
two agree:

| | paint | width | padding | viewport fit | anim | single-line | Ctrl+A scope |
|---|---|---|---|---|---|---|---|
| `SelectContent` | hand-rolled literals | hardcoded | none | ✅ | ✅ | ❌ | ❌ |
| `DropdownMenuContent` | `SURFACE_LEVELS` | hardcoded | hardcoded | ✅ | ✅ | ✅ | ❌ |
| `PopoverContent` | `SURFACE_LEVELS` | role ✅ | role ✅ | **❌** | ✅ | ✅ | ✅ |
| `FloatingSurface` | `<Surface>` | role ✅ | role ✅ | opt-in, default off ⚠️ | ❌ | ❌ | ✅ |
| `DialogContent` | `SURFACE_LEVELS` | own sizes | own | ✅ (75vh) | ✅ | ✅ | ✅ |

The bug is not an oversight in one file — it is the predictable result of the panel
having five definitions. The fix is to give it one, and to make viewport-fit and
Ctrl+A scoping **invariants of that one** rather than arguments a call site can
forget.

The five *components* stay: they are three distinct base-ui state machines
(listbox / menu / dialog) plus one deliberately focus-less Floating-UI surface.
Merging them would mean re-implementing base-ui. What gets extracted is the panel
they all contain.

## Design

A new `OverlayPanel` in ui-kit owns: `SURFACE_LEVELS.overlay` paint, the animation
class blob, the width/padding/max-height roles, the sticky `header`, the
`OverlayBoundary` + `SingleLineProvider` wrappers, and the Ctrl+A scope handler.

```tsx
<OverlayPanel width="anchor-min" padding="xs" maxHeight="lg" header={header} className={className} />
```

Four props, all optional, all purely visual. Nothing an agent can silently miss.

### Invariant 1 — fit-to-viewport, unconditional

`overflow-x-hidden overflow-y-auto` moves **out** of the role map and onto the panel
unconditionally. `POPOVER_MAX_HEIGHT` roles become a *comfort cap* folded into the
same clamp:

```ts
export type PopoverMaxHeight = "viewport" | "sm" | "md" | "lg" | "xl";
export const POPOVER_MAX_HEIGHT: Record<PopoverMaxHeight, string> = {
  viewport: "max-h-[var(--available-height,100vh)]",
  sm:  "max-h-[min(12rem,var(--available-height,100vh))]",
  md:  "max-h-[min(16rem,var(--available-height,100vh))]",
  lg:  "max-h-[min(20rem,var(--available-height,100vh))]",
  xl:  "max-h-[min(24rem,var(--available-height,100vh))]",
};
```

Three details that are load-bearing, not cosmetic:

- **Rename `"none"` → `"viewport"`.** Keeping the name while inverting its meaning
  is exactly the kind of thing that gets misread once and never reviewed again. The
  union is closed with 5 total call sites; the compiler does the migration.
- **One `max-h` class per role, never a clamp *plus* a cap.** Two classes in the same
  tailwind-merge group only compose correctly if nobody touches the order.
  `min(cap, var(--available-height))` encodes both in one class and keeps a caller's
  `className` override resolving cleanly.
- **`var(--available-height, 100vh)` fallback.** The var does not exist until
  Floating UI's `size.apply` has run once; an undefined var invalidates the whole
  `min()` at computed-value time → `max-height: none` → one full-height frame on
  first paint.

### Invariant 2 — Ctrl+A scope handler on the panel root

**Not** a `<ContentScope>` wrapper — that wrapper would *break Select*.
`SelectPopup` applies `height: 100%` to the popup and `LIST_FUNCTIONAL_STYLES`
(`maxHeight: 100%`) to the list when `alignItemWithTrigger` is on, which is
`SelectContent`'s default (`select.tsx:68`). An intervening auto-height div makes
that percentage resolve against nothing and Select's scrolling silently dies.

Instead, mirror the precedent that already exists in
`primitives/css/surface/web/internal/surface.tsx:60-63` — the scope handler on the
root, applied **after** `{...rest}` so nothing clobbers it, and **no `tabIndex`**:

```tsx
onKeyDown={(e) => { rest.onKeyDown?.(e); scopeSelectAllKeyDown(e); }}
```

`tabIndex` is only needed by `ContentScope` to make an otherwise-unfocusable pane div
focusable. Base-ui already stamps `tabIndex: -1` on every popup
(`floating-ui-react/hooks/useInteractions.js:38-42`) and `FloatingFocusManager`
imperatively rewrites it afterward — passing our own would be value-identical today
and a silent coincidence tomorrow. Focus is already inside these panels, so the
keydown bubbles to the root regardless.

Verified safe on ordering: nothing in the base-ui stack reads Ctrl/Cmd+A.
`useTypeahead` bails on modifiers (`useTypeahead.js:91-95`), `useDismiss` only reads
Escape (`useDismiss.js:74-78`). Note `FloatingSurface` already has this scope via
`<Surface>`; the two surfaces genuinely gaining it are `DropdownMenuContent` and
`SelectContent`.

Requires one export addition: `select-scope` exposes `scopeSelectAllKeyDown` (today's
private `handleSelectAllScope`, `select-scope.tsx:14`) and defines `selectScopeProps`
in terms of it, so ui-kit doesn't reach into an object literal.

### `render`-prop composition

Base-ui does `React.cloneElement(yours, mergeProps(baseUIProps, yourProps))` —
className concatenated yours-first, `style` object-merged, handlers chained
yours-first, plain props yours-wins, `ref` merged. Rendering a custom component
through `render` is already idiomatic here (`launch-sidebar-item.tsx:54`).

Two rules the composition depends on:

1. **A real host element at `OverlayPanel`'s root** with `{...rest}` spread onto it.
   A render target whose root emits no DOM node silently drops `ref`/handlers/aria —
   the failure mode `no-provider-trigger-render` exists for (that rule does *not*
   currently cover `render` on a `*Popup`; see step 8).
2. **`{...props}` before `render`**, and `Omit<…, "render">` on each public prop
   type, so a caller cannot clobber the panel. The caller's `className` must stay the
   **last** `cn()` argument — that is what keeps `pane-chrome.tsx:351`'s `min-w-0` and
   every future override working.

### Width roles

Three additions fold the last hardcoded widths into the ramp: `"anchor"`
(= trigger width, Select), `"anchor-min"` (= grow past trigger, Menu), `"snug"`
(= `w-max min-w-24 max-w-(--available-width)`, for `DropdownMenuSubContent`, which
has no meaningful anchor width and currently re-applies `SURFACE_LEVELS.overlay` a
second time at `dropdown-menu.tsx:194`).

Both anchor roles must be written with in-var fallbacks (`var(--anchor-width,0px)`),
**and** `FloatingSurface` must publish `--anchor-width`/`--anchor-height` from
`rects.reference` — base-ui publishes them
(`useAnchorPositioning.js:214-222`) but `FloatingSurface`'s `size.apply` sets only
`--available-*` (`floating-surface.tsx:132-144`). Without both, two roles of the
shared ramp are silently inert on one of the five consumers.

### `OverlayBoundary.kind` — deleted

`kind` feeds exactly one thing: `report.slot` in the crash report
(`error-boundary/web/index.ts:28`). It is **not** part of the crash fingerprint —
that is `sha256(errorType + top 3 normalized stack frames)`
(`reports/plugins/crash/core/crash-kind.ts:18`) — and `componentStack` is already
captured and rendered into the task (`render-crash-task.ts:96`) carrying the real
consumer chain. `slot` is already `.nullable().optional()` in the schema
(`crash-kind.ts:13`) and the renderer guards `if (data.slot)`, so no server or schema
change is needed.

Delete `kind` from `Props` and `OverlayFallbackProps`, drop the attribute at all 6
call sites, and hardcode `slot: "overlay"` in the fallback registration so the inline
crash chip keeps a meaningful tag.

## Steps

Each step type-checks and leaves the app functional on its own. The behavior change
is front-loaded so the reported bug is fixed on day one and the refactor lands under
no time pressure.

**1 — BEHAVIOR CHANGE. Fix the overflow class in the role map.** (~40 lines)
`ui-kit/web/theme/popover-width.ts`: rename the union, rewrite the map per above,
move `overflow-*` out. `ui-kit/web/components/ui/popover.tsx`: add
`maxHeight = "viewport"` and the overflow pair to the existing `cn()`.
`floating-surface.tsx`: default `maxHeight = "viewport"`; add the overflow pair; add
the flip/size hysteresis and publish `--anchor-*` (below). Fix
`page/plugins/math/plugins/inline/…/inline-math-plugin.tsx:77` → `width="fit"`.
Ships the fix for the "Turn into" menu and for every `InlinePopover` and
`CaretTriggerMenu` site at once.

**2 — PURE REFACTOR. Introduce `OverlayPanel`; migrate `PopoverContent`.**
New `ui-kit/web/components/overlay-panel.tsx`, beside the hand-authored
`portal-forward.tsx` (not under `components/ui/`, which `ui-kit/CLAUDE.md` declares
shadcn-CLI-owned). Export from the ui-kit barrel as one pure re-export line.
Verify the emitted class string is byte-identical to step 1's.
Only DOM delta: `ContentScope`'s div disappears, replaced by the root handler.

**3 — PURE REFACTOR (+1 gain). Migrate `DropdownMenuContent`.** Add the three width
roles; `width = "anchor-min"`. Gains the Ctrl+A scope. Point
`DropdownMenuSubContent` at `"snug"` and drop its duplicated surface bundle.
`launch-control.tsx:111`'s `w-auto min-w-[15rem]` keeps working through twMerge and
gains `max-w-(--available-width)`.

**4 — MOSTLY-PURE REFACTOR. Migrate `SelectContent`.** `SURFACE_LEVELS.overlay`
replaces the hand-rolled paint — byte-identical visually, and it *adds* the
co-published `--chrome-mask`/`--hover-fill` vars, so a ghost `Button` inside a Select
finally hovers to `--accent` instead of the page `--muted`. Two deltas to call out in
the commit: `SingleLineProvider value={false}` is new for Select (a `<Text>` in a
custom item body may switch from ellipsis to wrap), and `OverlayBoundary` moves
outward from inside `Select.List` to wrap the arrows too. Keep
`SelectScrollUpArrow` / `Select.List` / `SelectScrollDownArrow` as children — both
wrappers are DOM-transparent, so the `maxHeight:100%` chain and the arrows'
absolute positioning survive.

**5 — PURE REFACTOR. Migrate `FloatingSurface`.** Swap `<Surface level="overlay">` +
inner `<OverlayBoundary>` for `<OverlayPanel ref={setFloatingEl} style={floatingStyles}
className="pointer-events-auto" …>`. Drops the `primitives/css/surface` edge from its
dependency set — update `floating-surface/CLAUDE.md`.

**6 — Migrate `DialogContent` (5th surface).** The outer
`DialogPrimitive.Popup` stays the full-viewport positioning wrapper; the inner
`<div data-slot="dialog-panel">` becomes an `OverlayPanel` with
`style={{ "--available-height": "75vh" }}` so the unconditional clamp reproduces
today's `max-h-[75vh] overflow-y-auto`. `POPOVER_WIDTH.content` is `""` so
`DIALOG_SIZES` doesn't conflict, and `p-lg` is already `POPOVER_PADDING.lg`. This
removes the last hand-rolled copy of the panel quartet. Tooltip stays out — a
one-line label with different chrome, where `max-h` is meaningless.

**7 — Delete `OverlayBoundary.kind`.** Per above: `overlay-boundary.tsx`,
`error-boundary/web/index.ts:28`, and the attribute at 6 call sites (the five
migrated surfaces plus tooltip).

**8 — Docs, lint, build.** An "OverlayPanel owns the panel" section in
`ui-kit/CLAUDE.md` beside the existing "Dialog owns the panel" one; rewrite the
`POPOVER_MAX_HEIGHT` comment block around the new contract. Widen
`no-provider-trigger-render` (`trigger-render-safety/lint/`) from `*Trigger`-only to
any root `render` prop (~3 lines) so the invariant step 2 depends on is actually
enforced. Then `./equin build` to regenerate the autogen reference blocks and
`docs/plugins-*.md`.

## Risks

**The flip ↔ size feedback loop (highest).** Making `max-h` depend on
`--available-height` couples the element's height to the placement that `flip`
decides *from* that height. floating-ui re-runs the middleware chain when `apply`
changes dimensions (`@floating-ui/core:1045-1052`); on the re-run `flip` measures a
popup just clamped to exactly the available space, sees zero overflow, and stops
flipping. Base-ui solves this with a deliberate 1px hysteresis
(`useAnchorPositioning.js:149-156`). `FloatingSurface` has `flip()` with padding 0
(`floating-surface.tsx:128-147`), which is fine only while the cap is a constant.
**Fix in step 1:** `flip({ padding: 9 })`, `shift({ padding: 8 })`,
`size({ padding: 8, apply })`. Without it, the `/` block menu whose content grows
while open stays pinned to a stale `--available-height` — the exact bug being fixed,
reintroduced through the back door.

**inline-math gains an X-axis clip.** `KatexMath`
(`math/plugins/render/…/katex-math-impl.tsx:30`) renders raw KaTeX into a fixed
`w-72` panel with no overflow handling; a long expression visibly spills outside the
surface today. CSS cannot pair `overflow-y: auto` with `overflow-x: visible`, so the
tail would become clipped and unreachable. Handled in step 1 via `width="fit"`.

**Three `CaretTriggerMenu` sites lose their unbounded height** (inline-math,
inline-date, url-paste — all rely on the `"none"` default). Content surveyed: bounded
`<Row>` lists and one formula preview, no nested scrollers. No behavior change when
content fits; the X-axis item above is the only real one.

**Two live `className` overrides** touch the width axis: `pane-chrome.tsx:351`
(`min-w-0`, with an eslint-disable) and `launch-control.tsx:111`
(`w-auto min-w-[15rem]`). Both keep working provided the caller's `className` stays
the last `cn()` argument. No call site anywhere passes `max-h-`/`overflow-`/`p-`/`flex`
to any of these components.

**Lint:** ui-kit is already exempt from `no-adhoc-layout` via
`plugins/primitives/plugins/css/plugins/**` (`css/lint/index.ts:34`). It is **not**
exempt from `no-adhoc-spacing` (zero exemptions repo-wide) — the sticky header's
`-mx-1 -mt-1` needs the same per-line disable it already carries. `no-adhoc-surface`
only harvests string literals inside a `className` JSX attribute, so
`SURFACE_LEVELS.overlay` as a member expression does not trip it outside
`components/ui/**`.

## Verification

1. `./equin build`, then `./equin check` (type-check + eslint + the
   `plugins-doc-in-sync` / registry checks).
2. **The reported bug**, driven for real rather than snapshotted blind:
   ```bash
   bun plugins/framework/plugins/tooling/plugins/e2e-harness/e2e/screenshot.ts \
     --url http://<worktree>.localhost:9000/pages/page/<id> \
     --click "Turn into" --out /tmp/turn-into
   ```
   Confirm the menu is clamped, scrolls internally, and its last item ("Page") is
   reachable — at a normal window height and at a deliberately short one.
3. **Per-surface smoke test after each migration step**, comparing the emitted class
   string against the pre-migration one (`getAttribute("class")` in the harness) —
   the cheapest proof that steps 2–6 are pure refactors.
4. **Select is the one to drive by hand**, because of the `alignItemWithTrigger`
   style injection: open a long Select, confirm it still scrolls, the selected item
   still aligns over the trigger, and both scroll arrows still work.
5. `/` block menu with a query typed then backspaced (the flip-hysteresis case), near
   the bottom edge of the window: confirm it flips upward instead of staying pinned.
6. `bun run test:dom plugins/primitives/plugins/css/plugins/ui-kit` and
   `./equin test plugins/primitives` for the existing suites.
