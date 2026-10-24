# Drain the `no-adhoc-layout` allowlist → 0

> **Status:** Plan. Mirrors the completed `no-adhoc-spacing` burndown (389 → 0,
> [`research/2026-06-12-global-drain-no-adhoc-spacing-allowlist.md`](./2026-06-12-global-drain-no-adhoc-spacing-allowlist.md))
> and builds on the layout-primitive API spec
> ([`research/2026-06-15-global-css-layout-primitive-apis.md`](./2026-06-15-global-css-layout-primitive-apis.md)).

## Context

The `no-adhoc-layout` ESLint rule (`plugins/primitives/plugins/css/lint/no-adhoc-layout.ts`)
bans raw layout utilities (`flex*`, `grid*`, `shrink/grow`, `min-w-0`, `items-/justify-/place-/self-`,
`absolute/fixed/sticky`, `inset-*`, `overflow-*`) repo-wide. It shipped with **471
grandfathered pre-rule offenders** allowlisted inline in
`plugins/primitives/plugins/css/lint/index.ts` between `// <BURNDOWN-START>` / `// <BURNDOWN-END>`,
exactly as the spacing rule once carried 389. New code is gated immediately; the
allowlist must drain to `[]` over time, each file converted to the layout primitives.

Unlike the spacing drain (mostly visual rhythm), **layout conversions change rendering** —
a wrong scroll/flex/positioning choice breaks visible structure. And the existing five
primitives (Stack/Inset, Frame, Grid, Cluster, Center, Overlay, TruncatingText) cover the
**dominant** families but leave ~300 real occurrences with no primitive home: scroll
containers (~100), arbitrary positioning (~150), clipping (~52), sticky headers (~24).

**Decisions locked with the user:**
1. **Build all missing primitives FIRST** (not eslint-disable the gaps).
2. **Pilot one batch** to validate the new primitives + mapping table before scaling.
3. Then drain the remaining ~450 files in subtree batches (the spacing playbook).

Intended outcome: `ignores: { "no-adhoc-layout": [] }`, the rule enforcing repo-wide with
only the permanent `css/plugins/**` exemption, every former offender expressed as a
primitive (or a documented `// eslint-disable -- reason` for genuine long-tail cases).

---

## Phase 0 — Build the four missing primitives (blocking prerequisite)

Each is a new sub-plugin under `plugins/primitives/plugins/css/plugins/<name>/`, automatically
covered by the PERMANENT exempt glob. **Scaffold to copy** (verified): `css/plugins/center/`
has `package.json`, `CLAUDE.md`, `web/index.ts` (barrel: named re-exports + `export default {…} satisfies PluginDefinition`),
`web/internal/<name>.tsx`. Mirror `grid`'s `grid-template.test.ts` for a pure class-map unit test.

**Shared conventions (byte-for-byte, like every css/* primitive):** `cn` from `…/ui-kit/web`;
`SpaceStep`/`StackAlign`/`StackJustify` imported from `…/spacing/web` (never redefined); copy the
local `GAP_CLASS`/`LAYER_CLASS` const maps as the existing primitives do; `as?: ElementType` default `"div"`;
`extends React.HTMLAttributes<HTMLElement>`; `className` composes **last**. No `lint/` (none contributes a rule).

### `Scroll` (~100 — highest value)
Owns overflow **and** the flex-child fill policy as one role — `min-h-0 flex-1 overflow-y-auto`
is a single concern; splitting `min-h-0` out re-exposes the "pane grows past parent, page scrolls
instead" footgun.
```ts
export type ScrollAxis = "y" | "x" | "both";
export interface ScrollProps extends React.HTMLAttributes<HTMLElement> {
  axis?: ScrollAxis;          // y(default)→overflow-y-auto overflow-x-hidden; x→swap; both→overflow-auto
  fill?: boolean;             // emit min-h-0 flex-1 (y/both) | min-w-0 flex-1 (x). default false
  hideScrollbar?: boolean;    // → no-scrollbar
  isolate?: boolean;          // → isolate (new stacking context)
  as?: React.ElementType;
}
```
Sizing (`h-full`, `max-h-96`) stays in caller `className` (`h-*`/`max-h-*` are not banned).
Supersedes the rule's own "scroll container is the canonical eslint-disable" comment — update
that comment in `no-adhoc-layout.ts` to point at `Scroll`.

### `Clip` (~52) — sibling of Scroll, keep orthogonal
```ts
export interface ClipProps extends React.HTMLAttributes<HTMLElement> {
  axis?: "both" | "x" | "y";  // both(default)→overflow-hidden
  fill?: boolean;             // → min-h-0 flex-1
  as?: React.ElementType;
}
```
`rounded-*`/`border` stay in `className`. **Not** for `overflow-hidden text-ellipsis whitespace-nowrap`
→ that is `TruncatingText`.

### `Sticky` (~24)
Reuse `OverlayLayer` map (copy `LAYER_CLASS` locally; `z-layers` has no web barrel) so no raw `z-*`.
```ts
export type StickyEdge = "top" | "bottom" | "left" | "right";
export interface StickyProps extends React.HTMLAttributes<HTMLElement> {
  edge?: StickyEdge;          // default "top"
  offset?: SpaceStep;         // default "none" (flush top-0/bottom-0)
  layer?: OverlayLayer;       // default "raised"
  as?: React.ElementType;
}
```
Emits `sticky` + `top-<step>`/etc. + `LAYER_CLASS[layer]`. `bg-*`/`border-*` stay in `className`.

### `Pin` (~150 absolute-with-offset — hardest; **sibling of Overlay**, not an extension)
Overlay stays pristine (full-bleed `inset-0` only). Pin is a point-anchored absolute child of a
caller-owned `relative` parent.
```ts
export type PinAnchor =
  | "top-left" | "top-right" | "bottom-left" | "bottom-right"   // corners
  | "top" | "bottom" | "left" | "right"                         // edge-centers
  | "center";
export interface PinProps extends React.HTMLAttributes<HTMLElement> {
  to: PinAnchor;              // required
  offset?: SpaceStep;         // inset from anchored edge(s). default "none"
  outset?: boolean;           // negative offset (overhang the corner, -top-1 -right-1). default false
  layer?: OverlayLayer;       // default "raised"
  decorative?: boolean;       // → pointer-events-none. default false
  stretch?: boolean;          // perpendicular axis → inset-y-0 / inset-x-0 (side-pinned full-height)
  as?: React.ElementType;
}
```
Emits `absolute` + `LAYER_CLASS[layer]` + per-anchor edge utilities. Corner → pin both edges
(`top-<step> right-<step>`, negative if `outset`). Edge-center → pin the edge + center the
perpendicular axis (`left-1/2 -translate-x-1/2`). `center` → `top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2`.
`stretch` → perpendicular `inset-y-0`/`inset-x-0`. The translate/`1/2` mechanics live **inside** the
exempt primitive (confirmed: `top-*`/`translate-*` are not banned anyway). Add a pure
`pin-classes.test.ts` for the anchor→class map.

### Do NOT build
- **Arbitrary grid templates (~12):** `grid-cols-[auto_1fr]` → prefer `<Frame leading content>`;
  `grid-cols-9` equal cols → `<Grid cols={9} minCellWidth="0">`; subgrid / responsive
  `grid-cols-2 sm:grid-cols-4` → `eslint-disable -- responsive/subgrid grid`.
- **Fixed (~41):** floating-UI popovers (`z-popover fixed w-72`, coords from `useFloating`) →
  `eslint-disable -- floating-ui fixed strategy` (or already popover-primitive internals);
  viewport banners (`fixed inset-x-0 top-0`) → `ViewportOverlay` or disable. Not worth a primitive.

**Phase 0 done:** four primitives build green (`./equin build`), pure class-map tests pass,
the [`css` skill](../.claude/skills/css/SKILL.md) layout list + this mapping table updated to name
Scroll/Clip/Sticky/Pin.

---

## Mapping table (raw combo → primitive)

| Raw | Primitive |
|---|---|
| `flex flex-col gap-N` / `flex-row gap-N` | `<Stack [direction="row"] gap>` |
| wrapping rigid chips | `<Cluster>` |
| rigid \| truncating \| rigid row | `<Frame leading content meta trailing>` |
| `min-w-0`+`truncate` label | `<TruncatingText>` (or a Frame `content`/`meta` slot) |
| `shrink-0` edge item in a row | Frame `leading`/`trailing` slot |
| `flex items-center justify-center` / `place-items-center` | `<Center>` (axis both/h/v) |
| responsive card grid / fixed N equal cols | `<Grid minCellWidth=…>` / `<Grid cols={N} minCellWidth="0">` |
| `absolute inset-0` full-bleed layer | `<Overlay behind/above [clickThrough]>` + `<Overlay.Interactive>` |
| `min-h-0 flex-1 overflow-y-auto` | `<Scroll fill>` |
| `flex-1 overflow-auto` | `<Scroll axis="both" fill>` |
| `h-full overflow-y-auto` / `max-h-96 overflow-auto` | `<Scroll [axis] className="h-full\|max-h-96">` |
| `overflow-x-auto` / `…no-scrollbar` | `<Scroll axis="x">` / `<Scroll hideScrollbar>` |
| `overflow-hidden` [`rounded border`] | `<Clip [className="rounded border"]>` |
| `min-h-0 flex-1 overflow-hidden` | `<Clip fill>` |
| `overflow-hidden text-ellipsis whitespace-nowrap` | `<TruncatingText>` (NOT Clip) |
| `sticky top-0 z-raised …` / `sticky bottom-0` | `<Sticky className=…>` / `<Sticky edge="bottom">` |
| `absolute top-1 right-1` / `-top-1 -right-1` | `<Pin to="top-right" offset="xs" [outset]>` |
| `absolute left-2 top-1/2 -translate-y-1/2` | `<Pin to="left" offset="sm">` |
| `absolute bottom-1 left-1/2 -translate-x-1/2` | `<Pin to="bottom" offset="xs">` |
| `absolute inset-y-0 right-2 flex items-center` | `<Pin to="right" offset="sm" stretch>` + `<Center axis="vertical">` |
| `…pointer-events-none` pinned/overlay layer | Pin `decorative` / Overlay `above` |
| grid templates / fixed popovers / banners | see "Do NOT build" → Frame, Grid cols, or `eslint-disable -- reason` |

**Frame vs Stack for a row:** the moment a row needs even one of `min-w-0`/`shrink-0`/`flex-1` to
behave (a rigid edge cluster + a truncating region), it is a **Frame** — its grid makes the
badge-over-title overlap bug unrepresentable. Simple no-negotiation rows (button rows, short
icon+label that never overflows) are **Stack**. When unsure, choose Frame.

**Residual `eslint-disable -- reason` (expected, not failure):** one-axis-center-only floats,
fractional/pixel/JS-computed coordinates (drag handles, canvas overlays — sonata piano-roll,
graph-canvas, profiling gantt, draw-canvas), transforms beyond centering translate, subgrid/responsive
grids, floating-UI `fixed`. Estimate Pin absorbs ~110/150; ~40 stay disabled. Do not over-fit.

---

## Phase 1 — Pilot batch

**Subtree: `conversations/.../jsonl-viewer/tool-call` (~22 files; trim to ~15-18).** It exercises
every primitive: Frame rows, Scroll panes (`task-progress-overlay`, output views), Pin badges /
hover-reveal buttons, Clip code regions, Overlay. Self-contained, high-traffic, has nearby DOM tests.

Goal: confirm `Scroll.fill` boundary, `Pin` anchor enum coverage, the Frame-vs-Stack tree is
decidable in practice; surface any missing prop. **Adjust the primitive APIs ONCE here, rebuild,
then freeze.** Lock the mapping table with any new rows. Include at least one long-content row to
validate the Frame choice.

### Phase 1 — COMPLETE (primitive APIs FROZEN as shipped)

Drained the 22 `jsonl-viewer/.../tool-call` files (allowlist entries removed; `bunx eslint`
clean → **zero `layout/no-adhoc-layout`**; `./equin build` green; verified against real
transcripts — collapsed Frame label-rows, Bash (`Clip`+`Frame`+`Scroll`), Edit/MultiEdit, Read,
Write all render with correct truncation and **no badge-over-text overlap**). **No primitive API
needed changing** — every rough edge resolved as a *composition pattern*, so Scroll/Clip/Sticky/Pin
and the mapping table are **frozen** for all downstream batches. Validated patterns to apply verbatim:

1. **Container-as-flexible-child bridge.** When a `Frame`/`Stack` must itself be the `flex-1 min-w-0`
   child of an *externally-owned (still-allowlisted)* flex row, neither has a prop for that. Bridge
   with exactly ONE documented `// eslint-disable-next-line layout/no-adhoc-layout -- flexible leaf
   of <parent>'s not-yet-drained content flex` on `className="min-w-0 flex-1"`; it folds away when the
   parent is drained. (Only instance: `tool-call-card.tsx` inside `collapsible-card`'s row.)
2. **`Frame`/`Stack as="button"` + element-only attrs.** Their props are typed
   `HTMLAttributes<HTMLElement>`, so a button-only attr like `type="button"` does **not** type-check
   (TS2322). Pattern: keep the real `<button type="button" className="w-full …">` as the interaction +
   chrome wrapper and put a `<Frame>` *inside* it for layout. Do **not** add `type` to Frame.
3. **Off-ramp `Pin`/`Sticky` offset.** A fixed offset not on the spacing ramp (e.g. `bottom-10` =
   2.5rem) is expressed by overriding the primitive's inline inset: `style={{ bottom: "2.5rem" }}`
   (Pin/Sticky merge caller `style` last) — comment it as off-ramp.
4. **Frame `content`/`meta` truncation rule.** A **string** slot auto-wraps in `TruncatingText`
   (truncates); a **node** slot gets a bare `min-w-0` div (NO truncate). To truncate a *styled* node
   (muted/colored text), pass `<TruncatingText className=…>` as the node — not `<Text>`/`<span>`.
5. **Scroll over a typography element.** Wrap `<Scroll …><Text as="pre" …/></Scroll>` (keeps Text's
   variant); use `<Scroll as="pre"|"div">` only for plain elements. Avoid `Scroll as={Text}` (the
   `as` prop collides with Text's own `as`). `overflow-auto` (no-wrap content) → `axis="both"`;
   `whitespace-pre-wrap` content → default `axis="y"`.
6. **Lone rigid control in a flexible slot** (e.g. a card `aside` that lands in Frame `meta`): use
   `<IconButton>` (rigid Button) instead of a hand-rolled `shrink-0` span — also gains tooltip + a11y.
7. **Genuine long-tail → `eslint-disable -- reason`** (no primitive, do not force-fit): responsive
   col-count grids and responsive flex-direction (`flex-col lg:flex-row`), per-child `self-center`,
   asymmetric two-axis wrap gaps (`gap-x-lg gap-y-2xs`). A *single* equal-width responsive card grid
   DOES map to `<Grid minCellWidth>`. (~3 such disables in `workflow-graph.tsx`, the DAG layout file.)

**Frame-vs-Stack in practice:** decidable as written. Icon|text|meta rows, summary rows
(badges|truncating-text), and banner rows (icon|wrapping-text, via `align="start"` + a node `content`)
all map cleanly to Frame; pure button bars and rigid 2-chip rows to `Stack`/`Cluster`/Frame-leading-only.

---

## Phase 2 — Waves over the remaining ~450 files

Group the allowlist (extract programmatically between the markers) by plugin subtree into ~14-16
batches of ~25-35 files (spacing sizing). Suggested waves, sequential:

- **A** conversation-view rest (~50) + code/file-pane — 2 batches
- **B** sonata (29, many Pin-disable canvas files) + studio (18) — 1-2
- **C** fields (~25) + config_v2/auth + page editor (~30) — 2-3
- **D** primitives/* (data-view, tree, data-table, folder-picker… ~45; they host Scroll/Clip) — 2
- **E** stats + debug/profiling + plugin-meta/facets (22) + ui/tokens (21) — 2
- **F** tasks (~20) + reorder/review/screenshot/layouts/tail — 1-2

**Run 3-4 Opus subagents per wave** (one batch each); waves sequential.

**Allowlist conflict-avoidance (all batches touch one file — `css/lint/index.ts`):**
**single-writer scheme.** The orchestrator removes a batch's allowlist lines **up front** (so the
rule goes live for those files), hands the now-enforced file list to a subagent; subagents edit
**only feature `.tsx` files, never `index.ts`.** This also fixes the verification trap: while a file
is still allowlisted, `eslint` passes spuriously — stripping the lines first makes the rule the live
oracle during conversion.

### Verification
- **Per file (subagent):** `bunx eslint <file>` → zero `layout/no-adhoc-layout` and **no new errors of any kind**.
- **Per batch:** `bunx eslint <batch files>` clean; `bun run test:dom <plugin>` where DOM tests exist.
- **High-risk files — screenshot before/after** (scroll panes, sticky headers, Pin/Overlay layers,
  any `min-h-0 flex-1` conversion):
  ```
  bun run playwright screenshot --wait-for-timeout 3000 --viewport-size "1280,800" \
    http://<wt>.localhost:9000/<route> /tmp/layout-<batch>.png
  ```
  Representative surfaces: conversation view (jsonl scroll + tool-call cards), tasks pane (sticky
  header), studio explorer (scroll + tree), settings→appearance (token rows), sonata library (Pin).
- **Final done state:** `ignores: { "no-adhoc-layout": [] }` (keep the key + the PERMANENT glob;
  update the BURNDOWN comment to "fully drained" per the spacing precedent), then
  `./equin check type-check` green (rule now repo-wide). Sanity grep: every remaining banned
  token in former offenders carries an adjacent `// eslint-disable-next-line layout/no-adhoc-layout -- …`.

### Risks
- **Layout regresses rendering** (unlike spacing) — screenshot the high-risk classes above.
- **Frame-vs-Stack misroute** is the top correctness risk: a Stack that needed Frame silently
  reintroduces the overlap bug (renders fine until content is long). Prefer Frame when ambiguous.
- **Never convert JS/inline-style-coordinate positions to Pin** — those are the disable cases
  (breaks drag/canvas).
- **Stop at build + verify; do NOT `git commit` / `./equin push`** — hand back for review.

---

## Execution — chained sub-tasks (one Singularity task per batch)

Implemented as a **linear chain** of Singularity tasks (`add_task` with `target` + `autostart: opus-4-8`).
Each agent, on finishing its batch, calls **`exit_clean`**, which completes the task and auto-launches
the next batch in the chain — no manual hand-off. Linear (not parallel) so each batch sees the prior
batch's real outcome, and **the single-writer allowlist concern disappears**: only one batch runs at a
time, so each agent safely edits `css/lint/index.ts` itself.

**Standing instructions baked into every conversion task** (each references this plan doc and works in
its own worktree):
1. Read this plan + the [`css` skill](../.claude/skills/css/SKILL.md). Extract this batch's subtree
   entries from the allowlist (between the markers in `css/lint/index.ts`).
2. **Remove those lines from the allowlist first** (so the rule goes live and `eslint` stops passing
   spuriously), then convert each file per the mapping table + Frame-vs-Stack tree.
3. Verify: `bunx eslint <files>` → zero `layout/no-adhoc-layout`, no new errors; `bun run test:dom <plugin>`
   where present; screenshot before/after for high-risk files (scroll panes, sticky headers, Pin/Overlay,
   any `min-h-0 flex-1`). `./equin build`.
4. Genuine long-tail → `// eslint-disable-next-line layout/no-adhoc-layout -- <reason>`.
5. **Do not commit / push.** On success call `exit_clean`; if blocked or APIs need changes, `flag_raise`.

**The chain (each `target`s the previous; by subtree, agent extracts live file lists):**
1. **Build the 4 primitives** — Scroll/Clip/Sticky/Pin + pure class-map tests + css skill update; build green.
2. **Pilot — `jsonl-viewer/tool-call`** (~15-18 files): validate APIs, **freeze** the primitive APIs + mapping table.
3. conversation-view chrome + remaining jsonl-viewer
4. code/file-pane + commits
5. sonata
6. studio
7. fields
8. config_v2 + auth + settings
9. page editor
10. primitives (data-view, tree, data-table, folder-picker…) — part 1
11. primitives — part 2
12. stats + debug/profiling
13. plugin-meta/facets + ui/tokens
14. tasks
15. **tail (reorder/review/screenshot/layouts/misc) + final gate** — assert allowlist `[]` and `./equin check` green.

If the pilot (task 2) forces primitive API changes, downstream tasks pick up the updated primitives
automatically (they reference this doc, not a frozen snapshot).

## Critical files
- `plugins/primitives/plugins/css/lint/index.ts` — the 471-entry allowlist to drain to `[]` (orchestrator-only edits)
- `plugins/primitives/plugins/css/lint/no-adhoc-layout.ts` — the rule (update the "scroll = disable" comment to point at `Scroll`)
- `plugins/primitives/plugins/css/plugins/center/` — sub-plugin scaffold to copy for scroll/clip/sticky/pin
- `plugins/primitives/plugins/css/plugins/overlay/web/internal/overlay.tsx` — sibling reference for Pin (layer map, absolute/relative, pointer-events)
- `plugins/primitives/plugins/css/plugins/grid/web/internal/grid.tsx` + `grid-template.test.ts` — pure class-map + test pattern for Pin/Sticky
- `.claude/skills/css/SKILL.md` — update the layout-primitive list (currently "five new") to add Scroll/Clip/Sticky/Pin
- Precedent playbook: `research/2026-06-12-global-drain-no-adhoc-spacing-allowlist.md`
