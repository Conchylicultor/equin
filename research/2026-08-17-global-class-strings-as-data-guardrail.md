# Class strings that travel as data escape every `no-adhoc-*` rule

## Context

`no-adhoc-viewport-overlay` exists to stop one silent bug: a box that says
`fixed inset-0` to mean "fill the viewport", bounded instead by a transformed
ancestor and clipped to the content area, with no error — it only shows up as a
wrong-looking screenshot. The rule fingerprints the recipe and redirects it to
`<ViewportOverlay>`, which portals to `document.body`.

The rule only sees that recipe when it is written **inside a `className`
attribute on an intrinsic tag**. A class string that travels as *data* — a
surface placement descriptor whose `containerClassName: "fixed inset-0
z-overlay bg-background"` is applied to a host-owned element several files away
— never trips it. The bug the rule exists to prevent is still expressible, one
indirection away, and the class of place where that happens is growing as more
chrome is contributed as descriptors rather than markup.

Investigating that turned up three things worth acting on.

**1. It is not one hole, it is a category, and the category is already leaking.**
The same blindness affects all nine `no-adhoc-*` class rules, because they all
anchor on the same two positions: a `className`/`class` JSX attribute, and a
`cn()`/`clsx()`/`twMerge()` argument. A third authoring position is already in
wide use and carries live violations today — a JSX attribute whose name is *not*
`className`:

| site | class string | banned by |
|---|---|---|
| `primitives/outline/plugins/rail/…/outline-rail.tsx:127` | `panelClassName="flex-col w-8 …"` | `no-adhoc-layout` |
| `conversations/…/prompt-template-chips.tsx:189` | `panelClassName="flex-col-reverse items-end gap-xs p-xs …"` | layout + spacing |
| `shell/global-action-bar/…/global-action-bar.tsx:127` | `panelClassName="items-center"` | `no-adhoc-layout` |
| `primitives/data-view/plugins/list/…/list-view.tsx:289` | `itemClassName="px-pane-gutter"` | `no-adhoc-spacing` |
| `apps/browser/…/omnibox.tsx:58`, `start-page/hero.tsx:45` | `wrapperClassName="w-full"` | — (benign) |
| `conversations/…/dep-popover-content.tsx:94` | `wrapperClassName="mb-1.5"` | `no-adhoc-spacing` |

None of these files is allowlisted. They are invisible purely because the
attribute is spelled `panelClassName` rather than `className`. This family is a
bigger live leak than the descriptor case that prompted the investigation.

**2. The rule reported here has two further holes beyond the one described.**

- **`HOST_TAGS` fails open.** The gate is `span|div|button|a`, so
  `<section className="fixed inset-0">` or `<main>`/`<nav>`/`<aside>` passes.
  Its sibling `no-adhoc-surface` already deleted its own identical gate, in
  those words: *"there is no tag-allowlist to fail open through (the former
  `HOST_TAGS` gate did just that)"*. `no-adhoc-viewport-overlay` is simply
  behind a decision the family already took.
- **No `CallExpression` anchor.** `no-adhoc-layout` and `no-adhoc-spacing` both
  visit `cn`/`clsx`/`twMerge` calls directly; this rule only walks into them
  when they sit inside a `className` attribute. A `const c = cn("fixed",
  "inset-0")` is invisible to it.

**3. The static rule was never able to catch the actual bug, and says so.** Its
own doc-comment: *"The ancestor relationship is a runtime DOM fact that crosses
plugin boundaries, so it can't be checked statically; instead we fingerprint
the viewport-fill recipe."* Meanwhile the real check already exists — but it
lives inside one feature plugin, fires only for one placement, and its report
sink has no registered handler, so outside dev it emits into nothing.

## Options considered

| | rung | catches | cost |
|---|---|---|---|
| **A. Brand a `ClassName` type** so a class-as-data field is only fillable via `cn()` | 2 | the whole category, by *relocating* literals into an anchor 7 rules already visit | ~67 mechanical edits; **zero** changes to any existing rule |
| **B. Widen `CLASS_ATTRS` to any `*ClassName` attribute** | 3 | the live JSX family above, immediately, with no migration | one constant, 8 rule files |
| **C. Add a data-position anchor** (`Property`/`VariableDeclarator` named `*ClassName`) to the rules | 3 | the descriptor case | needs a *second* byte-identical sentinel family + sync-check rework |
| **D. `PlacementDef` declares a frame role, not a class recipe** | 1 | the reported site, permanently | ~5 files |
| **E. Promote `assert-viewport-escape` to a primitive** | 4 | the *actual* bug, incl. spellings no static pass can see | ~6 files |

**C is not recommended.** It buys what A buys, but by growing a second family of
hand-duplicated, byte-identical rule code (the existing walk already needs a
`class-token-walk-in-sync` check to hold six copies together). A achieves the
same coverage by relocation instead of duplication.

## Recommendation

Ship **B → A → D → E**, in that order. B is a one-line-per-rule change that
pays immediately; A is the spine that closes the category; D upgrades the
reported site from "a lint error you can disable" to "a fact you cannot state";
E replaces the fingerprint with a real check.

### Phase B — widen the class-attribute anchor

In each rule's `CLASS_ATTRS` gate, accept any attribute whose name ends in
`ClassName` alongside `className`/`class`. Affects `no-adhoc-layout`
(`plugins/primitives/plugins/css/lint/no-adhoc-layout.ts`), `no-adhoc-spacing`,
and the six sentinel-fenced rules. Prefer a shared predicate over a `Set`:

```ts
const CLASS_ATTRS = /^(?:class|className)$|ClassName$/;
```

Then fix the ~8 real violations it surfaces (the table above) by routing them
through the layout/spacing primitives, or with a named per-site disable where
the prop genuinely forwards to a primitive that owns the mechanics.

While here, close the two extra holes in
`plugins/primitives/plugins/css/plugins/viewport-overlay/lint/no-adhoc-viewport-overlay.ts`:
delete the `HOST_TAGS` gate (mirroring `no-adhoc-surface`'s rationale verbatim)
and add the `CallExpression` anchor. Removing the gate makes three base-ui
sites visible (`ui-kit/web/components/ui/{dialog,sheet}.tsx`); exempt them with
the glob `no-adhoc-surface` already uses for the same files:
`plugins/primitives/plugins/css/plugins/ui-kit/web/components/ui/**/*.{ts,tsx}`
in `viewport-overlay/lint/index.ts`.

### Phase A — the `ClassName` brand

New `plugins/primitives/plugins/css/plugins/ui-kit/core/class-name.ts` (+ a
`core/index.ts` barrel). `core` may only import `core`, and it imports nothing,
so it is the lowest DAG node and can never cycle:

```ts
/**
 * A class string that came out of the class-name channel. Structurally it IS a
 * string — assignable to `string`, to `className?: string`, to clsx's
 * `ClassValue` — so nothing downstream changes. What it is NOT is constructible
 * FROM a string: `const c: ClassName = "fixed inset-0"` is a type error, and
 * the only place in the repo that mints one is `cn()`.
 *
 * This is a RELOCATION, not a new check. A class literal in a data position is
 * invisible to every `no-adhoc-*` rule; branding the FIELD forces its author to
 * write `cn("…")`, which moves the literal into the `CallExpression` anchor
 * those rules already visit. No rule changes.
 */
export type ClassName = string & {
  readonly __className: "build class strings with cn()";
};
```

`cn()` (`ui-kit/web/lib/utils.ts`) returns `ClassName` via the single `as
ClassName` cast in the codebase — deliberately greppable.

Migration, measured rather than estimated: **28 declarations** (13 distinct
field names — `badgeClassName`, `labelClassName`, `iconClassName`,
`containerClassName`, `panelClassName`, …) change `string` → `ClassName`;
**39 literal write sites** get wrapped in `cn(…)`; the class-string producers
that feed a branded slot (`insetClass`, `zLayerClass`, `pinClasses`,
`stickyClasses`, `hoverRevealClass`, the four debug colour helpers) get a
one-line return-type change. The 174 plain `className?: string` React props are
**deliberately untouched** — already covered at the JSX site, and branding them
would collide with every `icon: ComponentType<{ className?: string }>`.

Verify each wrapped string before/after: `cn()` runs `twMerge`, which is the
identity function on a non-conflicting string but drops the earlier of two
conflicting classes.

**The residual hole, and its plug.** Nothing stops the next API typing its
field `string`. Add `class-field-must-be-branded` to the existing
`ui-kit/lint/index.ts` barrel: a purely syntactic rule visiting
`TSPropertySignature`, `PropertyDefinition`, `TSTypeAliasDeclaration` and
`TSMethodSignature`, matching **compound** names only
(`/^[a-z][A-Za-z0-9]*(?:ClassName|ClassNames|Classes)$/`) and requiring the
annotation to be `ClassName` (or a union with null/undefined, or a function
returning it). The capital `C` is the whole discriminator: bare `className` is
React's DOM prop, already covered, and excluding it is what gives this rule a
zero false-positive rate against the current repo. It tokenizes nothing, so it
must **not** be added to `class-token-walk-in-sync`'s `EXPECTED` list.

Rename `GroupBgData.className` → `bgClassName`
(`primitives/graph-canvas/web/components/group-background.tsx:16`) — the one
data carrier using the bare name.

### Phase D — `PlacementDef` states the geometry once

`plugins/apps-core/plugins/surface/web/slots.ts` currently states one fact
twice: `containerClassName: "fixed inset-0 …"` says the mechanics and
`viewportRelative: true` says what they mean. Nothing keeps them agreeing, and
both directions fail silently *and plausibly*. The dangerous one: `fixed`
without `viewportRelative` leaves the backdrop's `transform-gpu` in place, so
the fullscreen app is clipped — and `assertViewportEscape` never runs, because
it is gated on that same flag. The check written for the failure is disarmed by
the failure.

Replace both with a role plus paint:

```ts
export type PlacementFrame = "pane" | "window" | "viewport";

  /** How the per-tab container is POSITIONED, as a role the host maps to
   *  mechanics. A role cannot disagree with itself. */
  frame: PlacementFrame;
  /** PAINT ONLY — background, border, radius. Geometry belongs to `frame`.
   *  `ClassName` makes that a checked contract: the value comes out of `cn()`,
   *  so `no-adhoc-layout` reads its tokens and rejects any positioning /
   *  clipping / flow class that tries to sneak back in. */
  paintClassName?: ClassName;
```

The host (`surface-body.tsx`) owns the recipe in one module const —
`FRAME_CLASS = { pane: "absolute inset-0", window: "absolute overflow-hidden",
viewport: "fixed inset-0 z-overlay" }` — and reads `activeDef?.frame ===
"viewport"` as the single fact driving both the dropped `transform-gpu` and the
runtime assert. Contributors become `frame: "pane" | "window" | "viewport"` plus
`paintClassName: cn("bg-background")` / `cn("rounded-lg border bg-background")`.
`absolute` and `overflow-hidden` move out of floating's string into
`FRAME_CLASS.window`: a window frame that leaks past its own corner is a bug in
every `window` mode, so the clip belongs to the role.

Solo's `z-overlay`-not-`z-max` docblock moves to `FRAME_CLASS`, where it
documents a role rather than one mode's taste.

**This phase depends on A.** With `paintClassName` left as `string`, a
contributor writes `paintClassName: "fixed inset-0"` and the role abstraction is
voided invisibly — the same bug, one field to the right.

### Phase E — promote the runtime auditor

`plugins/apps-core/plugins/surface/web/internal/assert-viewport-escape.ts` is
already a domain-neutral containing-block + stacking-context auditor
(`findViewportBlocker` walks to `<html>` checking `transform`/`filter`/
`contain`/`container-type`/`will-change`, then `opacity`/`isolation`/
`mix-blend-mode`/`z-index`). Move it verbatim into
`plugins/primitives/plugins/css/plugins/viewport-overlay/web/internal/`, beside
the rule and primitive that guard the same invariant. New DAG edge:
`viewport-overlay → primitives/report-sink/core` (which imports nothing).

Export `findViewportBlocker`, `assertViewportEscape(el, { subject, remedy, from })`,
`viewportEscapeReportSink`, and a `useViewportEscape(ref, opts)` hook. The
surface-specific wording demotes to caller-supplied `subject`/`remedy` strings;
the two fault *kinds* are properties of CSS, not of the surface. `from:
"self" | "parent"` matters: a `position: fixed` element is its own stacking
context, so an inclusive walk would always self-report.

Then: `ViewportOverlay` asserts its own chain in dev (a body-portaled box still
cannot escape a `filter` on `body`/`html`); `apps-core/surface` calls the same
hook through the barrel and deletes its private copy; and — the live defect —
**register the sink**, so a fault reaches Debug → Reports instead of a no-op.
Nothing calls `surfaceReportSink.register` today.

Optional follow-on, only if the phases above still leave gaps: a dev-only
`MutationObserver`-driven sweep (never a timer — polling is banned) that audits
elements whose computed `position` is `fixed`, catching spellings no static pass
can reach: CSS files, `el.style.position`, third-party markup, and ancestors
that turn hostile *after* mount.

## Critical files

- `plugins/primitives/plugins/css/plugins/viewport-overlay/lint/no-adhoc-viewport-overlay.ts` — `HOST_TAGS` removal, `CallExpression` anchor, widened attr gate
- `plugins/primitives/plugins/css/lint/no-adhoc-layout.ts` and the six sentinel-fenced rules — the `CLASS_ATTRS` widening
- `plugins/primitives/plugins/css/plugins/ui-kit/core/class-name.ts` (new), `…/ui-kit/web/lib/utils.ts`, `…/ui-kit/lint/index.ts`
- `plugins/apps-core/plugins/surface/web/slots.ts`, `…/web/components/surface-body.tsx`, and the three placement sub-plugins
- `plugins/apps-core/plugins/surface/web/internal/assert-viewport-escape.ts` → `plugins/primitives/plugins/css/plugins/viewport-overlay/web/internal/`

## Verification

1. `./equin check eslint` after each phase. Expect phase B to surface the
   ~8 violations tabulated above and nothing else; expect phase A to surface the
   three `apps-core/surface` placement strings.
2. `./equin check` in full — `class-token-walk-in-sync` must stay green
   (no new participant is added; the new declaration rule tokenizes nothing).
3. `./equin test plugins/primitives/plugins/css/plugins/viewport-overlay`
   — the rule's own fixture suite, extended with a data-position case and a
   `<section className="fixed inset-0">` case.
4. `./equin test plugins/apps-core/plugins/surface` — the keep-alive and
   viewport-escape suites must pass unchanged through phase D's rewrite; that is
   the guard that the role mapping reproduces today's classes byte-for-byte.
5. `./equin build`, then drive the real app: enter fullscreen (solo),
   confirm the tab covers the rail and the tab strip, open a dropdown from
   inside it and confirm the popover still paints above. Switch docked → solo →
   floating and confirm no tab remounts (scroll position survives).
6. Temporarily add `transform: translateZ(0)` to the surface backdrop and
   confirm phase E's assertion throws in dev, naming the offending element.
