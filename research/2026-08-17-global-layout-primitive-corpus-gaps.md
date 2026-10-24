# Layout primitives: closing the `no-adhoc-layout` disable corpus

**Date:** 2026-08-17
**Category:** global (css primitives, the lint rule, ~160 consumer files)
**Status:** plan, awaiting approval

## Context

`layout/no-adhoc-layout` bans raw Tailwind layout utilities and redirects them to
the primitives under `plugins/primitives/plugins/css/plugins/*`. Feature code
escapes per-site with `// eslint-disable-next-line layout/no-adhoc-layout -- <reason>`.

There are now **329 such directives across 161 files**. Read as a corpus, the
authors' own reasons say the same handful of things over and over — which means
this is not 329 judgement calls, it is a small number of missing shapes plus two
defects in how the rule communicates.

Measured state (real `Linter.verify()` sweep over 6,658 files with every
contributed rule loaded, not an estimate):

| | count |
|---|---|
| `layout/no-adhoc-layout` directives | 329 |
| …suppressing a live report | 293 |
| …**already dead** (rule never fired) | **39** |
| dead directives across all contributed rules | 68 |

Age: 239 directives were written in June 2026 during the original drain, 36 in
July, 16 in August — so the rule is holding at ~25/month, and what is still
being written is concentrated in two shapes (coordinate-positioned boxes, and
the subgrid data-table).

**Correction to the counts that motivated this work.** The first pass counted
class tokens per multi-line snippet rather than per reported element, which
inflated per-family figures. The corrected split, measured off real lint
reports: **38** sites write `shrink-0` alone, **20** write `flex-1` alone,
**13** write `min-w-0` alone, and only **14** write the `min-w-0 flex-1` pair.
Every number below is the measured one.

Two pieces of context that shape the plan:

- **`<Frame>` was deleted on 2026-06-21**, two days after the "471 → 0 drained"
  commit, and ~130 files were re-allowlisted into `css/lint/index.ts`. Several
  disable reasons still cite `Frame`; they are stale.
- **Nothing detects a dead disable today.** `linterOptions.reportUnusedDisableDirectives`
  is unset, so ESLint's flat-config default leaves it at `warn`, and the
  type-check worker discards warnings (`worker.ts:105` filters `severity === 2`).
  That is why 39 directives suppress rules that never fire.

---

## What lands, in order

Ordering is deliberate: the cheap guardrails first (so migrations cannot leave
litter), then the primitives that drain the most per line, then the type change
with the widest blast radius.

### Stage 1 — guardrails (cheap, land before any migration)

**1.1 Fail on dead disable directives.** One property, in the shared builder so
`eslint.config.ts` and the type-check worker cannot drift —
`plugins/framework/plugins/tooling/plugins/lint/core/build-lint-config.ts`, first
entry of `baseConfigs`:

```ts
files: ["**/*.{ts,tsx}"],
linterOptions: { reportUnusedDisableDirectives: "error" },
```

Companion fix, required: the worker prints `${m.ruleId ?? "(parse)"}`
(`.../checks/plugins/type-check/shared/worker.ts:109`), and an unused-directive
message has `ruleId: null` — so every one would be labelled a parse failure.
Distinguish the two.

Measured fallout for contributed rules: **68 dead directives** (39
`no-adhoc-layout`, 9 `no-adhoc-spacing`, 7 `no-module-mutable-store`, 5
`no-bare-catch`, 4 `no-reactive-server-io`, 2 `no-adhoc-radius`, 1 each
`no-adhoc-density` / `no-adhoc-typography`).

⚠️ **Unmeasured risk — resolve before landing.** Type-aware and base rules were
excluded from the sweep. `@typescript-eslint/no-unnecessary-condition` has 171
directives and is configured `warn`, so whether they are live is currently
unobserved. Run one full type-aware pass
(`bunx eslint . --report-unused-disable-directives`) for the true number: small ⇒
land at `error` and delete the dead ones in the same commit; large ⇒ mechanical
prep commit first. Do **not** compromise at `warn` — it is a no-op in this repo.

**1.2 Make the rule's message name every primitive.** The `adhocLayout` message
names 9 primitives and omits 8 that exist and are usually the right answer —
`Line`, `Fill`, `Column`, `Clip`, `Scroll`, `Pin`, `Sticky`, `Inline`. It also
never mentions the class-string escape, which is why `fillClasses()` has **zero**
callers outside its own plugin while `insetClass()` (advertised in its CLAUDE.md)
has 6. Rewrite the message as an indexed list by mechanic, and name the escape:

> When you cannot wrap the element (a third-party `className` prop, a Lexical
> `ContentEditable`), take the class string instead: `fillClasses(axis)`,
> `insetClass(step)`.

Hardcoded, not data-driven: the primitive set is closed by construction, and lint
rules dual-load under jiti, **which cannot resolve `@plugins/*`** — a registry
import is the one form that provably does not work here. Guard it instead with a
directory-derived `css:message-names-primitives` check at
`plugins/primitives/plugins/css/check/index.ts`.

Docs in the same commit: `css/CLAUDE.md`, `fill/CLAUDE.md` (add a "when you only
have a className" section), `.claude/skills/css/SKILL.md`.

**1.3 Correct two stale docs.** Both claim the allowlist is fully drained while
136 glob entries exist. `.claude/skills/css/SKILL.md:113` is the damaging one —
auto-loaded by every agent, and it instructs *"don't add entries back"*. Also
`research/2026-06-20-css-primitives-audit.md` §7, plus its §4 table, whose rows
point at `Frame` (deleted) and `TruncatingText` (never existed as a plugin).

**1.4 Adopt the shared class-token walk.** `no-adhoc-layout` carries an older,
weaker copy of the walk and lacks the `// >>> shared:class-token-walk` sentinel,
so it sits outside the `class-token-walk-in-sync` check. The six rules inside it
resolve same-file identifier→map aliases; this one does not. Four real escapes
are invisible to the rule today — `docked-placement.tsx:21`,
`floating-placement.tsx:52`, `solo-placement.tsx:32`, `bar.tsx:48`. Strict
tightening; costs one sentinel-delimited block copy and `EXPECTED` growing to 7.

### Stage 2 — the small primitives (~66 sites, two ~60-line plugins + two additions)

Independent of each other; land in any order.

**2.1 `<Layer>` + `layerClasses()`** — new plugin `css/plugins/layer`. **19 sites.**
A standalone `absolute inset-0` child. `Overlay` takes its layers as *props* and
requires in-flow `children`, so it cannot express a layer that *is* an element or
a sibling — 19 reasons say "not an Overlay wrapping content".

- Props: `layer?: InTreeLayer` (default `base`), `decorative?: boolean`, `as`, `ref`.
  No `offset`, no `mask`, no `stretch` — all 30 `inset-0` corpus sites are exactly
  `inset-0`, none wants a partial inset.
- Defaults live in `layerClasses()`, not the component, so they cannot drift.
- The class form is the more important half: it covers the `<img>` / `<svg>` /
  `<button>` / `<textarea>` / third-party-`className` hosts.
- Parent-chain-identity sites (`surface-body.tsx:238`, `app-tabs-body.tsx:35`) are
  safe — `Layer` renders exactly one element at the same depth. Note the one-time
  remount in the migration commit so a reviewer isn't guessing.
- **Rejected:** `Overlay.Layer` (implies a containment that is false at every
  site) and `Pin to="fill"` (Pin's published contract is the *point* anchor).
- First migrations: `tree-row-chrome.tsx:99`, then the
  `desktop-backdrop.tsx` / `desktop-wallpaper.tsx` cluster.

**2.2 `<Rigid>` + `rigidClass()`** — new sibling plugin `css/plugins/rigid`. **34–38 sites.**
`<Fill>` owns `min-w-0 flex-1`; nothing owns `shrink-0`, and 38 sites write it as
their only banned token.

- Sibling plugin, not inside `fill`: the governing precedent is `Scroll`/`Clip`
  (two halves of overflow, kept sibling). `Stack`/`Inset` cohabit only because
  they share `SpaceStep`; `fillClasses` and `rigidClass` share no data.
- **No axis prop** — `flex-shrink` applies along whichever axis the container
  declares as main. Document the asymmetry with `Fill` or someone will "fix" it.
- The helper is the default answer; ship `<Rigid>` too for symmetry and for the
  rigid-spacer idiom (`<Rigid className="w-16"/>` replaces the Gantt spacers).
- **Rejected:** a per-child role on `Stack`/`Row`/`Line`. The rigid leaves don't
  know their host ("must not shrink inside its consumer-owned flex row"), and
  annotating children needs `cloneElement` or slots-as-props — which is what
  `Frame` did before it was deleted. Named-slot containers own rigidity for their
  slots (`Column` already does); a leaf that travels owns it for itself.
- Check four "rigid band in a flex column" sites against `Column` *first*:
  `conversation-view.tsx:88`, `prompt-form.tsx:36`, `app-tab-bar.tsx:109`,
  `piano-roll.tsx:608` (`Column scrollBody={false}` may now fit it).
- First migrations: `task-status.tsx:103` (already on a primitive, needs only the
  class), then `shared.tsx:159,178` (template for the other 10 Gantt sites).

**2.3 `selfClass(align)`** — into `spacing`. **7 sites (+1 partial).**
Lives next to `insetClass` and keyed by the same `StackAlign`, so the child
override and the container's `align` prop draw from one closed set.
**No `<Self>` component** — a wrapper would become the flex item and the child
would stretch inside it, so the component form is not redundant but wrong.
Note: `spacing` has no pure class test today; this adds its first.

**2.4 `Pin` `spanOffset`** — one prop. **6 sites (+4 migration-only).**
Framed as *removing* `pinClasses`' last class-vs-style special case: the spanned
axis stops being a hardcoded `inset-x-0`/`inset-y-0` and becomes inline insets
like every other edge. After it, `pinClasses` emits classes only for `absolute`,
the z-layer, `pointer-events-none`, the mask's centering, and the translate trick.
Forced to `0` under `mask`, for the same reason the anchor inset already is.
`pinClasses` has zero external callers, so the change is contained; two existing
test assertions must be rewritten. The migration at each site is a **nested Pin**
(6px hit strip outside, 2px bar inside).

### Stage 3 — the coordinate primitive (~52 sites, the largest and fastest-growing)

**3.1 `<Plane>` + `<Placed>`** — new plugin `css/plugins/coords`.

The single biggest cluster: a box placed by runtime numbers — Gantt bars and
ticks, piano-roll notes, windowed-list offsets, drag ghosts, crop rects, DOMRect
highlights. `Pin`'s docs explicitly exclude this; the corpus says that call was
wrong.

```ts
export type Coord = number | string;          // px, or any CSS length/percentage
export type Extent =
  | "fill"
  | { start: Coord; size?: Coord; minSize?: Coord; end?: never; center?: never }
  | { end: Coord;   size?: Coord; minSize?: Coord; start?: never; center?: never }
  | { start: Coord; end: Coord; size?: never; minSize?: never; center?: never }
  | { center: Coord; size?: Coord; minSize?: Coord; start?: never; end?: never };

export type PlacedProps = PlacedBase &
  ( | { motion?: "inset";    x: Extent;      y: Extent }
    | { motion: "transform"; x: StartExtent; y: StartExtent } );

export function pct(fraction: number): string;   // the `${f * 100}%` every site hand-rolls
```

- The `?: never` arms make an over-specified extent a tsc error rather than a
  silently-resolved conflict. Both axes required — omitting one leaves the CSS
  *static position*, the one genuinely surprising outcome.
- Coordinates are always `Coord`; `transform` is not a different coordinate kind
  but a different *mechanism*, hence the `motion` axis narrowing `x`/`y`.
- **Per-frame imperative writers are in scope, not excluded.** Those sites render
  `absolute inset-0` and write `transform` via a ref; default `motion="inset"`
  emits no transform, leaving the writer sole owner. Rule to document: such an
  element must use `motion="inset"` and must not use a `center` extent
  (centering uses `translate(-50%)`, which the writer would clobber).
- `layer` defaults to **no z class** (unlike `Pin`'s `raised`) — the bar/overlay
  sites depend on DOM paint order.
- `planeClasses` **delegates** to `clipClasses`/`fillClasses`; `Plane` composes
  `layerClasses()` rather than re-deriving `absolute inset-0`, so 11 coordinate
  *hosts* handed over from 2.1 share one mechanic.
- **No lint-allowlist edit needed** — the permanent `css/plugins/**` glob already
  covers new sub-plugins.
- Refactor `use-gantt-zoom.ts` to return *fractions*: formatting moves to `pct()`,
  the `0.3%` min-bar floor moves to `minSize`. That deletes the string-returning
  API that made the helper unreusable across four files.
- **Will not cover:** `position: fixed` (stays with `viewport-overlay` /
  `cursor-menu` — a `fixed` mode would re-open the transformed-ancestor bug those
  exist to prevent); 11 mixed-family sites that also carry `flex`/`items-*`, two
  of which (`keyboard.tsx:308`, `block-rail.tsx:57`) are hit-test elements where
  inserting a child is a behaviour change, not a refactor; `window-chrome.tsx:315`.
- Migration phases: profiling Gantt → timeline/op-gantt → windowed lists
  (introduces `motion="transform"`) → measured-rect overlays and editor
  decorations → the Sonata projection family last (it holds every imperative
  writer and the tightest domain coupling).
- **Delete, don't convert**, the 5 directives in this cluster that were always
  dead (`virtual-rows.tsx:182`, `notation.tsx:312,321,323`, `songsheet-line.tsx:64`
  — their only class is `relative`, which the rule never banned). Stage 1.1 will
  force this.

### Stage 4 — polymorphic `as` (~22 sites, widest blast radius)

**4.1 Generic props over the host element.** 21 primitives declare
`as?: React.ElementType` but type props as `React.HTMLAttributes<HTMLElement>`, so
`as="button"` rejects `type`/`disabled`, `as="img"` rejects `src`. Authors drop to
a raw element and disable the rule, saying so out loud.

```ts
export type CenterProps<T extends React.ElementType = "div"> = {
  axis?: CenterAxis;
  as?: T;
} & Omit<React.ComponentPropsWithRef<T>, "axis" | "as">;
```

Verified compiling against this repo's exact toolchain (TS 6.0.3, React 19.2.14,
strict + `noUncheckedIndexedAccess`), 11 positive cases and 3 `@ts-expect-error`
negatives. Findings: the body needs **no cast** (`const As = as ?? "div"`);
`Omit` must always include `"as"` (`ComponentPropsWithRef<"link">` has its own
`as` attribute); `ref` becomes correctly typed per host, so the explicit
declaration is deleted. One cast per generic→generic composition boundary
(7 total: Bar→Line, Row→Line, Cluster→Stack, Inline→Stack, Card, ToggleChip→Badge,
SectionLabel→Text).

**This supersedes the `[key: string]: unknown` index signature** in `badge`,
`card`, `surface`, `line`, `toggle-chip` — `Line`'s own comment states it exists
to forward element-specific props, which is exactly what the generic does *with*
typing. Delete all five in wave 1.

It does **not** supersede the class helpers. The distinguishing question is *do
you own the element?* — own it ⇒ generic `as`; don't own it (a third-party
`className`-only prop, a raw leaf you cannot wrap) ⇒ `layerClasses()` /
`rigidClass()` / `fillClasses()` / `insetClass()`. State that boundary in 1.2's docs.

Roll out in three waves so fallout is contained, not repo-wide (992 `as=` sites,
777 of them `Text`): **wave 1** the 5 index-signature holes (~30 sites, gains
typo-checking they have never had — any error surfaced is a genuine bug, never
suppress it); **wave 2** the 12 low-traffic layout primitives (~75); **wave 3**
`text`/`section-label`/`stack`/`inset` (~890) alone. `row` is out of scope — it
has no `as` and needs a 3-arm discriminated union; file separately.

---

## Explicitly rejected

**Narrowing the rule when an element carries coordinate inline styles.** This was
the original proposal; drop it. Four measured reasons:

1. **The premise is false.** "Coordinates are data, so no primitive can improve
   them" is contradicted by `CursorAnchoredMenu`, `MeasureStrip`, `Pin`, and
   `<Placed>` itself. Coordinate-carrying positioning is what several primitives
   are *for*.
2. **It deletes the migration inventory.** The corpus analysis was only possible
   because 52 documented reasons exist; narrowing converts them to 52
   undocumented sites at the moment the remedy lands.
3. **Measured false negatives** — `toaster-host.tsx:55` (constant corner offsets;
   should be `ViewportOverlay` + `Pin`) and `drag-selection.tsx:21` would be
   silently legalised.
4. **The proposed mitigation does not work.** Keeping it visible at `warn` is a
   no-op: the type-check worker filters `severity === 2`, so a warn never fails a
   check, never appears in a build, and lives only in an editor.

It would also make the rule internally inconsistent: `checkStyle`'s own docstring
treats offsets as *ignorable* and `position` as the discriminating token; the
narrowing makes offsets *exculpatory*. Applied to the style path it would exempt
`style={{position:"fixed", left, top}}` — verbatim the cursor-menu bug that path
exists to catch.

The precision complaint behind it is legitimate; the remedy is `<Placed>` plus the
migration, not the exemption. Re-measure the residue afterwards, with names.

## Follow-ups (not in this plan)

- **A `divider`/`rule` primitive.** Three sites are the same unnamed 1px hairline
  shape — `window-dock.tsx:110` (in flow), `resize-handle.tsx:45` and
  `jog-wheel.tsx:84` (absolutely positioned, "centered on one axis, spanning the
  other"). Better than distorting Pin's anchor vocabulary for two call sites.
- **Grow-only and floor-only helpers.** 20 sites write `flex-1` alone and 13 write
  `min-w-0` alone; `fillClasses()` emits both, so it is a drop-in for only 14.
  The reasons show genuinely distinct roles ("pure growing spacer pinning
  trailing actions right" vs "truncate leaf inside Bar's flex row"). Design this
  next to `rigidClass()`, not here.
- **The subgrid data-table** (~9 sites, actively growing) — `col-span-full` +
  `grid-cols-subgrid` has no primitive and was out of scope for all three
  workstreams.
- **`row`'s index signature** — needs a 3-arm discriminated union.

## Verification

- **Per primitive:** a pure `*-classes.test.ts` co-located with the source, run by
  `./equin test plugins/primitives/plugins/css/plugins/<name>`. `planeClasses`
  asserts *equality with* `clipClasses`/`fillClasses` output rather than hardcoded
  strings, so a change in `Clip`/`Fill` fails there instead of drifting silently.
- **Geometry:** a `coords` fixture in the layout-harness (`noClip`/`noOverlap`
  invariants across the width sweep — the containment property all 52 sites rely
  on). The harness check keys its cache on the whole `css/plugins/**` tree, so it
  re-runs automatically and launches no browser when untouched.
- **Types:** `./equin check type-check` after each `as` wave, plus one
  `@ts-expect-error` fixture per wave under `web/__tests__/` — it fails the build
  when the error *stops* occurring, locking in strictness against a future "just
  add an index signature to unblock myself".
- **Visual, per migration phase:** `./equin build` (background), then the
  e2e screenshot script against the real surface — Debug → Profiling for the Gantt,
  Debug → Slow Events for the timeline, a data-view list for windowed rows. Sonata's
  progress bar must be checked **with playback running**; a static screenshot
  cannot show that the per-frame imperative writers still move.
- **Whole gate:** `./equin check` — `eslint` (the disables must be *gone*,
  and after stage 1.1 a leftover directive is itself an error), `type-check`,
  `layout-geometry`.
