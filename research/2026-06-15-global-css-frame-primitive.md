# `Frame` — the named-slot row primitive (build task)

> **Status:** Implementation plan. Builds the `Frame` primitive whose prop surface
> is frozen in [the API spec](./2026-06-15-global-css-layout-primitive-apis.md) §1
> and sequenced in [the vision doc](./2026-06-15-global-css-layout-primitives-vision.md)
> Phase 1. **Scope: `Frame` + its geometry/overlap test only** — not Grid/Cluster/
> Center/Overlay, not the `no-adhoc-layout` lint rule, not the `CollapsibleCard`
> migration (each its own downstream task).

## Context

No primitive owns a row's shrink hierarchy. Rows with a rigid leading cluster +
flexible content + secondary metadata re-derive flex space-sharing per call site —
each sprinkling `min-w-0` / `shrink-0` / `flex-1` and hoping the negotiation
converges. The result is a recurring overlap/clip bug class; the canonical victim is
the `CollapsibleCard` header (`badge-over-path overlap`), where container policy and
leaf truncation are fused onto one `<div className="flex … min-w-0">`.

`Frame` is the structural fix: a horizontal row of up to four **role slots** with the
shrink hierarchy baked into one place — CSS Grid, the mode where "container crushed by
its own chip" is unrepresentable. Callers write roles (`leading`/`content`/`meta`/
`trailing`), never mechanics. A geometry/overlap test proves no two tracks collide
across a content-length × width matrix — the same bounding-box technique that
diagnosed the original 11.3px overlap.

The API is already locked with the user (slots-as-props, no `children`); this task
implements it and validates the exact grid track function empirically.

## Placement

New `css/` umbrella, per the spec's recommendation (avoids a build-then-move; it is
the eventual shared home of the upcoming Grid/Cluster/Center/Overlay):

```
plugins/primitives/plugins/css/                 # pure grouping umbrella (no runtime barrel)
  plugins/frame/
    package.json                                # @singularity/plugin-primitives-css-frame, private
    CLAUDE.md                                   # hand-written prose + autogen block (build fills it)
    web/
      index.ts                                  # barrel
      internal/
        frame.tsx                               # component + FrameProps + frameGridTemplate()
        frame-grid-template.test.ts             # bun:test — pure track-string assertions
        frame-geometry.test.ts                  # Playwright/Chromium — bounding-box matrix
```

Import path: `@plugins/primitives/plugins/css/plugins/frame/web`. The boundary
grammar already permits arbitrary nesting depth (`@plugins/<name>/plugins/.../web`),
so `./equin check plugin-boundaries` needs no config change. Mirror an existing
**leaf-less umbrella** (e.g. `plugins/packages/`) for whatever scaffolding the
codegen expects of the `css/` folder itself (likely just an autogen `CLAUDE.md`); the
build regenerates `*.generated.ts`, `docs/plugins-*.md`, and the AUTOGEN blocks.

## The component

`frame.tsx` — mirror the `Stack` shape byte-for-byte (closest presentational
precedent): `extends React.HTMLAttributes<HTMLElement>`, `as: As = "div"`,
`className` composed **last** via `cn(...)`, types named `Frame*` and re-exported
inline (`export { Frame, type FrameProps, type FrameAlign } from "./internal/frame"`),
default `PluginDefinition` export at the end of the barrel.

```tsx
export type FrameAlign = "center" | "start" | "baseline"; // subset of StackAlign

export interface FrameProps extends React.HTMLAttributes<HTMLElement> {
  leading?: ReactNode;   // rigid cluster — auto track, never shrinks
  content?: ReactNode;   // primary — minmax(0,1fr), truncates LAST
  meta?: ReactNode;      // secondary — minmax(0,auto), truncates FIRST
  trailing?: ReactNode;  // rigid-right cluster — auto track, never shrinks
  gap?: SpaceStep;       // default "sm"
  align?: FrameAlign;    // default "center"
  as?: React.ElementType;
}
```

`SpaceStep` imported from `@plugins/primitives/plugins/spacing/web`. `gap-<step>` /
`items-*` Tailwind utilities apply to grid the same as flex, so reuse `GAP_CLASS`-
equivalent mapping (copy the closed lookup pattern from `stack.tsx`; do not redefine
`SpaceStep`).

### Track function — single source of truth, computed from present slots

Render **only present slots** (absent slot ⇒ no child ⇒ no track ⇒ no phantom grid
gap). A pure exported function builds the template from which slots are present, so
the component and both tests share one definition:

```ts
// exported — the load-bearing logic under test
export function frameGridTemplate(present: {
  leading: boolean; content: boolean; meta: boolean; trailing: boolean;
}): string {
  return [
    present.leading  && "auto",
    present.content  && "minmax(0,1fr)",
    present.meta     && "minmax(0,auto)",   // ← candidate; validated by geometry test
    present.trailing && "auto",
  ].filter(Boolean).join(" ");
}
```

Apply it via inline `style={{ gridTemplateColumns: frameGridTemplate(present) }}` on a
`display:grid` root (inline style keeps the template a JS constant — testable, and
avoids an awkward comma-laden arbitrary Tailwind class). This is the sanctioned home
for layout CSS, so the inline style is correct here, not a smell.

### Internal slot wrapping (caller never sees it)

- **leading / trailing** → rigid cluster: an inner `flex items-center` + the chosen
  `gap` (`trailing` right-justified). The `auto` track cannot be crushed below this
  cluster's content — chips/icons stay whole.
- **content / meta** → a `min-w-0` flexible track wrapper. If the prop is a **string**,
  Frame wraps it in `<TruncatingText>` itself (mirrors TruncatingText's own
  string-convenience). A **node** gets the bare `min-w-0` track and the caller composes
  the truncation leaf where needed — so a chips+text label keeps its chips whole and
  only the text ellipsizes (the exact thing `collapsible-card.tsx:126-132` hand-rolls).

`TruncatingText` from `@plugins/primitives/plugins/truncating-text/web`.

### The shrink-priority caveat (the real work)

The spec flags that naive `minmax(0,1fr) minmax(0,auto)` does **not** guarantee
"meta hits 0 before content gives up a pixel" under all width ratios — grid splits
the overflow deficit across both shrinkable tracks. The **geometry test is the
oracle**: implement the candidate above, run the matrix, and if the priority fails,
iterate the `meta`/`content` track functions until it holds. Documented fallbacks to
try in order:

1. Cap meta at its content size and let content own the slack:
   `content: minmax(0,1fr)`, `meta: fit-content(40%)` or `minmax(0,max-content)`.
2. Give content an explicit floor so it stops shrinking last:
   `content: minmax(<floor>,1fr)` while `meta: minmax(0,auto)`.
3. Weighted `fr` split if both must shrink but content slower.

The **API in `frame.tsx` (the props) is stable regardless** of which track function
wins — only the string returned by `frameGridTemplate` changes.

## The geometry / overlap test

jsdom (`bun run test:dom`) **cannot** compute CSS grid layout —
`getBoundingClientRect` returns zeros there. The geometry test therefore drives the
pre-installed **Playwright/Chromium** (see root `e2e/`), measuring real track boxes.
It imports `frameGridTemplate` (the exact function the component uses) so the proof is
faithful without compiling Tailwind — `auto`/`minmax`/`1fr` are native CSS.

`frame-geometry.test.ts` (a `*.test.ts` run on demand via `bun test <path>`; not in
any automatic gate):

1. `chromium.launch()` headless; for each matrix cell `page.setContent(...)` a div with
   `display:grid; grid-template-columns: <frameGridTemplate(present)>; width:<W>` whose
   children are: a fixed-width rigid span (leading), a long/short text run with
   `min-width:0; overflow:hidden; text-overflow:ellipsis` (content), an optional text
   run (meta), a fixed-width rigid span (trailing) — i.e. the DOM Frame emits.
2. **Matrix:** `{short, long} content × {with, without} meta × {narrow=240px, wide=720px}`
   (× leading/trailing present, to cover the `CollapsibleCard` shape). Read each slot's
   `getBoundingClientRect()`.
3. **Assertions:**
   - **No overlap:** for adjacent slots, `right(n) <= left(n+1) + ε` (ε≈0.5px). Catches
     a regression where a missing `min-w-0` lets content overflow its track onto meta —
     the original bug's signature.
   - **No clip past container:** every slot's `right <= container.right + ε` and
     `left >= container.left - ε`.
   - **Rigid integrity:** leading/trailing widths equal their natural width in every
     cell (never crushed).
   - **Shrink priority:** in `long content × with meta × narrow`, `meta.width` is
     reduced to (near) its floor while `content.width` stays above meta's — i.e. meta
     gives up space first. This is the assertion that drives the track-function choice.

`frame-grid-template.test.ts` (`bun:test`, pure, fast): assert the exact template
string for each present-slot combination (e.g. all four ⇒
`"auto minmax(0,1fr) minmax(0,auto) auto"`; content+meta only ⇒
`"minmax(0,1fr) minmax(0,auto)"`). Locks the single-source-of-truth function and runs
without a browser.

## Critical files

- **Mirror byte-for-byte:** `plugins/primitives/plugins/spacing/web/internal/stack.tsx`
  (`SpaceStep`, `GAP_CLASS`, `as`/`className` shape), `…/spacing/web/index.ts` (barrel).
- **Truncation leaf:** `plugins/primitives/plugins/truncating-text/web` (`TruncatingText`).
- **Frozen API + track caveat:** `research/2026-06-15-global-css-layout-primitive-apis.md` §1.
- **Bug this closes (downstream migration):**
  `plugins/conversations/plugins/conversation-view/plugins/jsonl-viewer/plugins/collapsible-card/web/components/collapsible-card.tsx:107-148`.
- **Umbrella scaffolding precedent:** `plugins/packages/` (leaf-less umbrella).
- **Playwright precedent:** root `e2e/screenshot.mjs` (Chromium launch pattern).
- **Plugin scaffolding rules:** `plugins/framework/plugins/web-sdk/CLAUDE.md`.

## Verification

1. `./equin build` — regenerates registries, `docs/plugins-*.md`, and CLAUDE.md
   AUTOGEN blocks from the new `css/` + `frame` folders; must succeed and
   `plugins-registry-in-sync` / `plugins-doc-in-sync` pass.
2. `./equin check plugin-boundaries` — clean (deep-nesting import path is legal).
3. `bun test plugins/primitives/plugins/css/plugins/frame/web/internal/frame-grid-template.test.ts`
   — template strings correct.
4. `bun test plugins/primitives/plugins/css/plugins/frame/web/internal/frame-geometry.test.ts`
   — all matrix cells pass no-overlap / no-clip / rigid-integrity / shrink-priority.
   **This passing is the definition of done** — it both proves the fix and certifies
   the final track function.
5. (Optional sanity) drop a `<Frame leading content meta trailing>` into a scratch
   render and screenshot via `bun e2e/screenshot.mjs` to eyeball the narrow case.

## Out of scope (downstream tasks, per the vision)

Migrating `CollapsibleCard` → `Frame`; building Grid/Cluster/Center/Overlay; the
`no-adhoc-layout` lint rule + burndown; the `css/` directory extraction of existing
plugins (spacing/badge/row/…).
