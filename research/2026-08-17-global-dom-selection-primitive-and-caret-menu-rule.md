# The DOM selection read is a primitive; the caret-menu rule aims at the menu

## Context

`caretAnchor` — a ~30-line read of the document selection's caret rect, depending
on nothing but `window.getSelection()` — is exported from the caret-trigger
**menu** primitive's barrel. `no-adhoc-caret-trigger` treats importing it as
evidence the file is building a caret menu, and errors when the file does not
also call `useCaretMenu`.

That rule's own doc predicted this:

> The rule does not distinguish a "menu" from a caret-anchored surface with
> nothing selectable. There is no such surface today, and `caretAnchor` living in
> a menu primitive's barrel is what would need fixing first if one appeared.

One appeared. The collapsed-caret pending-marks cue is caret-anchored with
nothing selectable, so it could not import the helper and hand-writes its own
empty-block rect fallback in `format-toolbar-plugin.tsx`, with a comment naming
the lint rule as the reason.

Two facts found while investigating make the fix both cheaper and bigger than the
report suggests:

- **`caretAnchor` has exactly one caller** — `CaretTriggerMenu`, inside the
  primitive, via a relative path. Nobody outside imports it. The barrel export
  exists *only* to be the lint rule's tripwire. **`FloatingSurface` likewise has
  exactly one production consumer**: `CaretTriggerMenu`.
- **The cue is the third and weakest copy of this read, not the second.**
  `page/editor/web/internal/caret-geometry.ts`'s module-private `caretLineRect()`
  already answers "where is the caret" *correctly* for the two cases both other
  copies get wrong — an empty soft line, and the caret beside an inline decorator
  chip, where a collapsed range paints **nothing**. The cue's current fallback is
  the editor root's whole box, so on a multi-line block the chip lands under the
  *entire block* rather than under the caret's line.

Underneath all three sits one idiom with a **three-part guard nobody remembers
all of**: no selection → `rangeCount === 0` → `getRangeAt(0)` throwing
`IndexSizeError`. `caretAnchor` has all three. `caretLineRect` and
`diff-view`'s copy handler each have the first two and not the third.

**Outcome:** the guarded selection read becomes a leaf primitive every consumer
takes; `caretAnchor` becomes plugin-private; the cue anchors to the caret's real
line; and `no-adhoc-caret-trigger` stops keying on where a rect helper lives and
keys on the **menu panel** instead — which strengthens it, because it then fires
on every hand-rolled caret menu regardless of where its anchor came from.

## The design

Three things are conflated in caret-trigger's barrel today:

| | today | after |
|---|---|---|
| reading the DOM selection's range/rect | `caret-anchor.ts` (+ 2 other copies) | `primitives/dom-selection` |
| adapting a rect into a live FloatingSurface anchor | `caretAnchor`, **exported** | `caretAnchor`, **plugin-private** |
| the caret MENU (trigger + keyboard + surface) | the rest of the barrel | unchanged |

The rule keyed on the first because it was the only export `url-paste` took. It
should key on the third.

### 1. New leaf primitive: `plugins/primitives/plugins/dom-selection/`

Web-only, four files, mirroring `primitives/in-view` and `primitives/latest-ref`
byte-for-byte (`package.json`, `web/index.ts` barrel, `web/internal/…`,
`CLAUDE.md`). Imports nothing — no React, no Lexical, no FloatingSurface.

```ts
/** The live document selection's range, or null when there is none to read. */
export function selectionRange(): Range | null;
/** That range's bounding rect, or null when it carries no box. */
export function selectionRect(): DOMRect | null;
/** A rect the layout engine actually painted (`width || height`). */
export function hasBox(rect: DOMRect): boolean;
```

Named `dom-selection`, not `selection-rect`, for two reasons: it owns the
**range** read (`diff-view` wants the range for content, not geometry), and the
name distinguishes it from Lexical's model `$getSelection` — a distinction
`format-toolbar-plugin` juggles on every line.

`selectionRange()` is the one statement of the three-part guard. `hasBox()` is
the one statement of "a rect with no box is not an anchor", today spelled three
ways: `caret-anchor`'s all-four-zero test, `caret-geometry`'s private `usable()`,
and `format-toolbar`'s `isEmptyRect()`. The two `width && height` versions are
correct and the all-four-zero one is the outlier, so `hasBox` takes the
`width || height` form — a no-op in practice, stricter in principle.

### 2. `caretAnchor` leaves the barrel

`caret-anchor.ts` keeps `caretAnchor`, rebuilt on `selectionRect()`, and its
`export { caretAnchor }` line is **deleted from
`caret-trigger/web/index.ts`**. It has no external caller, so this costs
nothing and removes the misplacement outright: the menu primitive no longer
offers a surface-building export that is not the menu.

It is deliberately **not** promoted into `dom-selection`. It is a live virtual
element for one specific primitive's `anchor` prop, with one consumer — the
abstraction to build when a second appears, not before.

### 3. The cue anchors to the caret's line

`caretLineRect()` gains an `export` in `caret-geometry.ts` (its export chain is
currently `caretLineRect → measureVisualLines → readCaretContext`, all private).
`format-toolbar-plugin.tsx` already imports `$readMarkBoundary` from that module,
so this adds no new dependency edge.

```
cue:  caretLineRect() ?? root.getBoundingClientRect()   // was: rect ?? root…
bar:  selectionRect()                                   // was: getRangeAt(0).getBoundingClientRect()
```

`isEmptyRect` and the lint-rule comment are deleted; the remaining
root-fallback check uses `hasBox`. In the common case `caretLineRect()`'s
primary branch is `pickEdge(range.getClientRects(), "first")` on the collapsed
range — the same narrow caret box as today, so nothing moves. Only in the
branches where today's read yields all-zero does it differ, and there it borrows
the neighbouring node's line box instead of the editor root's — strictly better
on **both** axes.

### 4. The rule aims at the menu panel

`no-adhoc-caret-trigger`'s shape (2) evidence set changes:

- **drop** `caretAnchor` (no longer exported)
- **keep** `CaretTriggerMenu` from the caret-trigger barrel
- **add** `FloatingSurface` from `@plugins/primitives/plugins/floating-surface/web`

Fires when any of those is imported in a file that never calls `useCaretMenu`.
Shape (1) (`registerUpdateListener` + `indexOf`) is untouched.

This is a **strengthening**, not a swap. `FloatingSurface`'s own charter is "a
focus-less, caret-anchored floating surface … for transient caret menus", and its
only production consumer is `CaretTriggerMenu`, so "you rendered the caret-menu
panel — where is the keyboard model?" has zero false positives today. It also
catches variants the old rule could not: a hand-rolled menu anchored to an
element rect rather than a caret rect never touched `caretAnchor`, and slipped
through.

The cue does not use `FloatingSurface` (it positions itself inside a
`ViewportOverlay`), so it is clean with **no exemption**.

**The named next step, replacing the doc paragraph this task is about:** when a
*second*, genuinely non-menu caret-anchored `FloatingSurface` consumer appears,
the answer is an `interaction: "inert" | "menu"` discriminator on
`FloatingSurfaceProps` — inert makes the panel's content `pointer-events: none`,
so a mouse-only menu becomes unrepresentable (rung 1), and the rule reads the
declaration instead of guessing. Not built now: one live arm and no second
consumer is speculative generality.

### 5. New lint plugin: `dom-selection-safety` / `no-raw-selection-range`

Bans `<x>.getRangeAt(...)` outside the primitive — a single `CallExpression`
visitor on a member-expression property named `getRangeAt`, mirroring
`no-raw-intersection-observer`'s shape. Bare `getSelection()` stays legal:
`.toString()`, `.anchorNode`, `.isCollapsed`, `.removeAllRanges()` are widely and
legitimately used and need no guard. `getRangeAt` is the one read that does.

`ignores` has **exactly one entry** — the primitive's own internal file — because
all three current callers are migrated rather than exempted:

| site | becomes |
|---|---|
| `caret-trigger/web/internal/caret-anchor.ts:19` | `selectionRect()` |
| `page/editor/web/internal/caret-geometry.ts:325` | `selectionRange()` (gains the missing `IndexSizeError` guard) |
| `page/editor/web/components/format-toolbar-plugin.tsx:281` | `selectionRect()` |
| `primitives/diff-view/web/components/diff-view.tsx:158` | `selectionRange()` (gains it too) |

`diff-view` is the one consumer outside the caret story: its copy handler reads
the range to find which cells intersect. It is migrated, not exempted — a rule
that needs an allowlist entry for a *correct* use is enforcing less than it looks.

## Files

**New**

- `plugins/primitives/plugins/dom-selection/{package.json,CLAUDE.md}`,
  `web/index.ts`, `web/internal/dom-selection.ts`
- `plugins/framework/plugins/tooling/plugins/lint/plugins/dom-selection-safety/{package.json,CLAUDE.md}`,
  `lint/index.ts`, `lint/no-raw-selection-range.ts`,
  `lint/no-raw-selection-range.test.ts`

**Modified**

- `…/caret-trigger/web/index.ts` — drop the `caretAnchor` export
- `…/caret-trigger/web/internal/caret-anchor.ts` — build on `selectionRect()`;
  its header stops claiming to be the shared source of the rect read
- `…/caret-trigger/{package.json,CLAUDE.md}` + `web/index.ts` description — drop
  "and the shared caretAnchor" from the plugin description (all three copies must
  agree or `plugins-doc-in-sync` fails)
- `page/plugins/editor/web/internal/caret-geometry.ts` — export `caretLineRect`;
  `usable()` built on `hasBox`; `caretLineRect` takes `selectionRange()`
- `page/plugins/editor/web/components/format-toolbar-plugin.tsx` — both arms as
  above; delete `isEmptyRect` and the lint-rule comment
- `primitives/plugins/diff-view/web/components/diff-view.tsx` — `selectionRange()`
- `…/lint/plugins/caret-trigger-safety/lint/no-adhoc-caret-trigger.ts` — evidence
  set + the `caretSurfaceWithoutMenu` message (it must now name `FloatingSurface`
  and say what a *non-menu* caret surface should do instead)
- `…/lint/plugins/caret-trigger-safety/lint/no-adhoc-caret-trigger.test.ts` —
  rewrite the `caretAnchor` invalid case as a `FloatingSurface` one; add a valid
  case for a caret-anchored surface that is not a menu
- `…/lint/plugins/caret-trigger-safety/CLAUDE.md` — rewrite shape (2); replace the
  "does not distinguish a menu" paragraph with §4's named next step
- `page/plugins/editor/CLAUDE.md` — in *Caret geometry is stated in LINE BOXES*,
  note `caretLineRect` is now exported and that the cue anchors to it; state that
  the guarded selection read lives in `primitives/dom-selection`
- `page/plugins/editor/e2e/pending-marks-cue-verify.ts` — new phase (below)

Regenerated by `./equin build`, never hand-edited: `docs/plugins-*.md`,
each `CLAUDE.md`'s `AUTOGENERATED` block, `web.generated.ts`, `lint.generated.ts`.

Research docs (`2026-06-24-global-caret-anchored-floating-surface.md`,
`2026-08-09-page-collapsed-caret-pending-marks-cue.md`,
`2026-07-09-global-caret-trigger-primitive.md`) are dated records and are **not**
rewritten, even where they now describe superseded structure.

## Verification

```bash
./equin test plugins/framework/plugins/tooling/plugins/lint/plugins/dom-selection-safety
./equin test plugins/framework/plugins/tooling/plugins/lint/plugins/caret-trigger-safety
./equin check          # type-check, eslint, plugins-registry-in-sync, plugins-doc-in-sync, plugin-boundaries
./equin build          # run in background — median ~10 min
```

The rule tests are the primary guardrail and must be written to fail first:
strip the `FloatingSurface` arm and the re-aimed rule's new invalid case must go
green-when-it-should-be-red.

Then, against `http://<worktree>.localhost:9000`:

```bash
bun plugins/page/plugins/editor/e2e/pending-marks-cue-verify.ts
bun plugins/primitives/plugins/text-editor/plugins/caret-trigger/e2e/caret-trigger-wedge.ts
bun plugins/page/plugins/url-paste/e2e/url-paste-keyboard.ts
bun plugins/page/plugins/inline-date/e2e/date-menu-verify.ts
```

`pending-marks-cue-verify.ts`'s existing probe reads `[data-caret-format-cue]` +
its text and filters only on "is painted" — it asserts nothing about position, so
all 8 existing phases pass unchanged and none of them covers the improvement.
**Add a phase that does**: put the caret on an EMPTY SOFT LINE (Shift+Enter at the
end of a multi-line block), arm the cue with Cmd+E, and assert the chip's `top`
sits within one line-height of the caret's own line rather than below the whole
block's box. That is the one behavior change in this plan, and it is the case the
current code gets wrong.

Two manual checks with no script:

- **Caret menus still anchor.** `/`, `[[`, `@`, `$$` and the gutter `+` open at
  the caret — including the gutter `+` on a fresh EMPTY block, the path that
  exercises `caretAnchor`'s root fallback through `selectionRect()`.
- **`diff-view` copy.** Select across several lines in a side-by-side diff and
  Cmd+C; the copied text must still be one side's lines only. This is the one
  edit outside the caret story.
