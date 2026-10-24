# Caret-trigger primitive: killing the `dismissedRef` latch class

## Context

Typing `/` in an **empty** page block sometimes does nothing — the slash menu never opens, permanently, for that block.

`plugins/page/plugins/editor/web/components/slash-menu-plugin.tsx` keeps a `dismissedRef` boolean latch, set on Esc / outside-press, meant to hold the menu closed until the `/` is removed from the text. Open-state is pushed imperatively through five early-return branches of a `registerUpdateListener` `sync()`, and each branch carries an unwritten obligation to reset the latch. Two of them don't:

```ts
if (!$isRangeSelection(sel) || !sel.isCollapsed()) { close(); return; }  // no reset
const node = sel.anchor.getNode();
if (!$isTextNode(node))                            { close(); return; }  // no reset
```

An empty Lexical block has **no TextNode** — the selection anchor is the ParagraphNode. So the `idx === -1` branch (the only thing that clears the latch after the `/` disappears) is unreachable exactly when the block is empty.

Repro: type `/` → Esc → Backspace → type `/`. Dead. It stays dead until you type non-slash text (recreating a TextNode so `idx === -1` can fire), which is why it reads as intermittent.

**This is not one bug — it is four copies of one bug.** Four plugins hand-roll the same caret-trigger popup, all with the same hole:

| Plugin | Trigger | File | Latch resets |
|---|---|---|---|
| `page/editor` | `/` | `web/components/slash-menu-plugin.tsx` | 3 branches |
| `page/inline-page-link` | `[[` | `web/components/inline-page-link-plugin.tsx` | 2 branches |
| `page/inline-date` | `@` | `web/components/inline-date-plugin.tsx` | 4 branches |
| `page/math/inline` | `$$` | `web/components/inline-math-plugin.tsx` | 3 branches |

The differing reset-branch counts are the tell: these files were copy-pasted, then independently patched. The root cause is not the missing reset — it is that **open-state is a latch mutated across N branches instead of a value derived from the editor**. A fifth trigger reintroduces the bug for free.

**Intended outcome:** one primitive, one derived-state implementation, zero reset obligations, and a lint rule so copy #5 can't happen. Two adjacent defects surfaced during review are fixed in the same pass (below).

## Additional defects found during design review

1. **Blur has no term in the derived model.** All four close on blur imperatively. A naive `open = hasTrigger && !dismissed` regresses: after blur the trigger text is still there, so the menu stays open. Focus must be a *dimension of the derived state*, not a side effect.
2. **Esc gate polarity differs per plugin, and both unifications are wrong.** `/` gates Esc on `open && items.length > 0`; the other three gate on `open`. Gate everything on `open` → `/` swallows Esc while showing nothing. Gate everything on `interactive` → Esc can't dismiss `[[`'s visible loading spinner or `@`'s visible "Keep typing a date…" hint. There are genuinely **three** gates, not one.
3. **Arrow keys.** `$$` deliberately registers no arrow commands so the caret can move through LaTeX. A shared hook that always registers them (returning `true` even on a 1-item list) swallows arrows.
4. **Two menus can be open at once** (pre-existing). In `@friday [[bar` with the caret after `bar`, `chrono.parse` extracts "friday" from the `@` query so the date menu opens, *and* `[[` opens. Both registered a CRITICAL `KEY_ENTER_COMMAND`; mount order silently decides who wins Enter.

## Design

### 1. Open-state becomes a pure derivation

```ts
type Trigger = { nodeKey: string; triggerIndex: number; query: string };
const triggerId = (t: Trigger) => `${t.nodeKey}:${t.triggerIndex}`;   // identity EXCLUDES query

type MenuState = { trigger: Trigger | null; dismissedId: string | null };

export function reduceTriggerState(prev: MenuState, t: Trigger | null): MenuState {
  if (!t) {
    // THE single place dismissedId is ever cleared. No branch can forget.
    return prev.trigger === null && prev.dismissedId === null
      ? prev
      : { trigger: null, dismissedId: null };
  }
  const same =
    prev.trigger !== null &&
    triggerId(prev.trigger) === triggerId(t) &&
    prev.trigger.query === t.query;
  return same ? prev : { trigger: t, dismissedId: prev.dismissedId };
}
```

`findTrigger(editorState, opts) → Trigger | null` collapses **all** the bail-outs — no selection, non-collapsed, not a text node, no trigger, boundary fail, invalid query — into a single `null`. The empty block is no longer a special branch; it is simply "no trigger", the same state as "never typed one".

Identity excludes `query`, so typing after Esc stays dismissed. Identity is `nodeKey:triggerIndex`, which Lexical may invalidate (a mark application splits text nodes; inserting text before the trigger shifts the index). **That is safe by construction: every identity mistake makes `dismissedId !== triggerId(trigger)`, i.e. the menu re-opens — recoverable. It can never wedge closed.** The failure mode is asymmetric on purpose.

> A plain boolean `dismissed`, cleared on the null transition, also fixes the reported repro and is immune to re-keying. It is rejected because it retains a narrow member of the same bug class: with `/bar hello /foo`, dismissing at `/foo` then clicking the caret after `/bar` leaves the second trigger wrongly dismissed — the menu stuck closed when it should open. Identity costs a benign spurious re-open; the boolean costs a wedge. We are eliminating wedges.

### 2. Focus is a dimension, not a side effect

```ts
open = trigger !== null && dismissedId !== triggerId(trigger) && focused && isCaretOwner
```

`FOCUS_COMMAND` / `BLUR_COMMAND` registered at CRITICAL, both `return false` (non-consuming, as today), flip `focused`. Blur therefore closes but **never latches** — returning to a block whose text still holds the trigger re-derives `open` correctly (re-opens if never dismissed, stays closed if it was).

### 3. Three gates, named

| Gate | Condition | Consumers |
|---|---|---|
| Arrows + Enter | `open && interactive` | `interactive` = host-supplied "there is something to commit" |
| Esc + outside-press | `surfaceOpen` | the exact boolean driving `<CaretTriggerMenu open>` |
| Blur | focus flip | never latches, `return false` |

`surfaceOpen` is derived inside the hook from a closed enum, not passed back in from render (which would lag a frame):

```ts
surfaceWhen: "open" | "interactive"   // default "open"
surfaceOpen = surfaceWhen === "interactive" ? (open && interactive) : open
```

`navigate: false` **skips arrow `registerCommand` entirely** — it is not a modeling flag.

### 4. Single-owner arbiter — at most one menu, ever

A module-level `WeakMap<LexicalEditor, Arbiter>` keyed on the composer instance. **No provider to mount** — a provider would be another "you must also…" obligation, i.e. the very coupling we are removing. Each hook publishes its candidate `triggerIndex` on every sync; the owner is the trigger whose start is **closest to the caret** (max `triggerIndex`).

```
@friday [[bar|
  @   triggerIndex 0   loses
  [[  triggerIndex 8   WINS   → losers derive open = false
```

All candidates necessarily share the anchor node (that's where `findTrigger` looks), and two distinct trigger strings cannot start at the same index — so the max is unique. Tiebreak by longer trigger string then by `id`, defensively. Enter becomes unambiguous: exactly one hook is `interactive`.

### 5. API

```ts
// primitives/text-editor/plugins/caret-trigger/web
export function useCaretTrigger(opts: {
  id: string;                    // unique per editor; arbiter key
  trigger: string;               // "/", "[[", "@", "$$"
  canOpen?: (ctx: { node: TextNode; triggerIndex: number; textBeforeCaret: string }) => boolean;
  isQueryValid?: (query: string) => boolean;
  itemCount: number;             // 0 ⇒ not interactive
  onCommit: (activeIndex: number) => void;
  navigate?: boolean;            // default true; false ⇒ arrows not registered
  surfaceWhen?: "open" | "interactive";   // default "open"
}): {
  open: boolean;
  surfaceOpen: boolean;
  query: string;
  activeIndex: number;           // clamped to [0, itemCount)
  setActiveIndex: (i: number) => void;
  dismiss: () => void;
};

export function CaretTriggerMenu(props): JSX.Element;   // FloatingSurface + caretAnchor() + onDismiss=dismiss
export function atWordBoundary(ctx): boolean;           // triggerIndex === 0 || /\s/.test(text[triggerIndex - 1])
export function caretAnchor(fallback?): FloatingAnchor | null;   // moved here
```

`itemCount` + `onCommit(index)` rather than a generic `items: T[]` — math has no list (its surface is a live KaTeX preview), and faking `items = query ? [query] : []` would be a leak. `itemCount = query === "" ? 0 : 1` is honest.

`atWordBoundary` hardcodes `triggerIndex === 0 ⇒ true`. (A naive `/\s/.test(text[idx-1])` evaluates `undefined` → `"undefined"` → `false`, wedging `/` and `@` at the start of a block.)

### 6. Placement

`plugins/primitives/plugins/text-editor/plugins/caret-trigger/` — the logic is pure Lexical with zero page knowledge, and `page → primitives` is the existing dependency direction, so no cycle. The conversation prompt-editor (`primitives/prompt-editor`) gets a `/` command menu for free later.

`caret-anchor.ts` **moves** out of `page/editor/web/internal/` into this plugin. Repo rules forbid cross-plugin re-exports, so `page/editor/web/index.ts` **drops** its `caretAnchor` export and imports it like everyone else. Five importers repoint: the four trigger plugins plus `page/url-paste` (`web/components/url-paste-plugin.tsx:91`, which uses the `fallback` arg and only needs the raw anchor).

Cycle check: `caret-trigger` imports only `lexical`, `@lexical/react`, `primitives/floating-surface`, `primitives/latest-ref`, `primitives/scoped-store`. It never imports `text-editor` (umbrella parent ≠ dependency) nor anything under `page/`.

`package.json` lists external npm deps only (`lexical`, `@lexical/react`) — `@plugins/*` resolve through the alias and `no-plugin-workspace-deps` forbids declaring them.

## Per-plugin migration

| | `canOpen` | `isQueryValid` | `itemCount` | `navigate` | `surfaceWhen` |
|---|---|---|---|---|---|
| `/` | `atWordBoundary` | `q => !/[\n ]/.test(q)` | `filtered.length` | ✓ | `interactive` |
| `[[` | — | `q => !/[[\]\n]/.test(q)` | `pending ? 0 : options.length` | ✓ | `open` |
| `@` | `atWordBoundary` | `q => !/[@\n]/.test(q) && buildMenu(q, new Date()).open` | `menu.options.length` | ✓ | `open` |
| `$$` | `ctx => !(ctx.triggerIndex === 0 && ctx.node.getPreviousSibling() === null)` | `q => !/[$\n]/.test(q)` | `query === "" ? 0 : 1` | ✗ | `open` |

Each plugin keeps its own surface child, its own `onCommit` (`convertTo` for `/`; node-insert + trailing space for the other three), and deletes `dismissedRef`, `lastQueryRef`, `close()`, the `sync()` effect, and its five `registerCommand` blocks.

**Intentional behavior changes** (all improvements, all to be called out at review):
- `[[`, `@`, `$$` gain outside-press dismissal (only `/` had `onDismiss` before).
- At most one menu opens (arbiter). Previously `@` + `[[` could both open.
- `$$` no longer commits Enter when another trigger owns the caret.

`commit()` needs no explicit `close()`: it removes the trigger text inside the same `lexicalEditor.update()`, the listener fires synchronously after, `findTrigger` returns `null`, React batches one render. No flash-of-open frame.

## Files

**New** — `plugins/primitives/plugins/text-editor/plugins/caret-trigger/`
- `web/index.ts` (barrel: re-exports + `export default {…} satisfies PluginDefinition`)
- `web/internal/caret-anchor.ts` (moved from `page/editor/web/internal/`)
- `web/internal/trigger-state.ts` — `reduceTriggerState`, `triggerId`, `isOpen` (pure)
- `web/internal/trigger-state.test.ts` — bun:test, co-located
- `web/internal/scan-trigger.ts` + `scan-trigger.test.ts` — pure string-level scan (`textBeforeCaret`, `trigger`) → `{ triggerIndex, query } | null`
- `web/internal/find-trigger.ts` — thin Lexical `.read()` wrapper over `scanTrigger` + `canOpen`
- `web/internal/arbiter.ts` — `WeakMap<LexicalEditor, Arbiter>`, `useCaretOwner`
- `web/internal/use-caret-trigger.ts`
- `web/components/caret-trigger-menu.tsx`
- `lint/index.ts` — `no-adhoc-caret-trigger` (step 8)
- `package.json`, `CLAUDE.md`

**Modified**
- `plugins/page/plugins/editor/web/index.ts` — drop `caretAnchor` export
- `plugins/page/plugins/editor/web/components/slash-menu-plugin.tsx`
- `plugins/page/plugins/editor/web/internal/caret-anchor.ts` — deleted
- `plugins/page/plugins/inline-page-link/web/components/inline-page-link-plugin.tsx`
- `plugins/page/plugins/inline-date/web/components/inline-date-plugin.tsx`
- `plugins/page/plugins/math/plugins/inline/web/components/inline-math-plugin.tsx`
- `plugins/page/plugins/url-paste/web/components/url-paste-plugin.tsx` — import repoint only

## Sequencing

Each step builds, type-checks, and passes `./equin check` on its own.

1. **Scaffold + move (no behavior change).** Create the plugin; move `caret-anchor.ts`; drop editor's re-export; repoint all five importers. Validates the boundary graph and the no-cycle edge before any logic moves.
2. **Add the pure core.** `scan-trigger.ts`, `trigger-state.ts` + both bun:test suites. Not yet consumed.
3. **Add the hook, arbiter, and component.** Focus gate, three-gate registration, `WeakMap` arbiter.
4. **Migrate `[[`** — the representative case (pending/loading, `surfaceWhen: "open"`, navigate).
5. **Migrate `@`** — adds `canOpen` + the `buildMenu(q).open` query gate + the hint surface (`open && !interactive`).
6. **Migrate `$$`** — adds node-context `canOpen`, `navigate: false`, the non-list commit seam. Land after the list cases so any API bend surfaces with the others stable.
7. **Migrate `/`** — most entangled (`convertTo`, `surfaceWhen: "interactive"`, introduces the `editor → caret-trigger` runtime edge).
8. **Add the lint rule.** `no-adhoc-caret-trigger`: flag any file that calls `registerUpdateListener` and `lastIndexOf` on a module-level `TRIGGER` const. Self-contained AST check, no cross-plugin imports (jiti can't resolve `@plugins/*` in rule files). This is what makes copy #5 impossible rather than merely unlikely.

## Verification

Typecheck and unit tests catch none of this — the failing path is stateful and lives in the DOM. Drive it.

**Unit (bun:test), the derivation itself:**
```bash
bun test plugins/primitives/plugins/text-editor/plugins/caret-trigger
```
Cases: empty-block transition clears `dismissedId`; dismissal survives query typing; dismissal does *not* survive the null transition; caret inside a partially-typed multi-char trigger (`[` of `[[`) yields `null`; two triggers in one node resolve to the rightmost; `atWordBoundary` at `triggerIndex === 0`.

**End-to-end**, a new `e2e/caret-trigger-wedge.mjs` (Playwright, modeled on `e2e/screenshot.mjs`) driving a real page at `http://<worktree>.localhost:9000/pages/page/<id>`. For each of `/`, `[[`, `@`, `$$`:

1. type the trigger → assert the popover is visible
2. press `Escape` → assert hidden
3. press `Backspace` until the block is empty
4. type the trigger again → **assert the popover is visible** ← the bug
5. blur (click another block) → assert hidden; refocus → assert visible again
6. click outside → assert hidden and *stays* hidden while the trigger text remains

Plus the arbiter: type `@friday [[bar` → assert exactly one popover in the DOM, and that it is the `[[` one.

**Manual**, after `./equin build`: confirm `$$` arrow keys still move the caret through LaTeX, and that Esc on a no-match `/zzzz` query does not swallow Esc from the surrounding UI.

`./equin build` regenerates `docs/plugins-*.md` and the plugin registries; `./equin check` must pass `plugin-boundaries`, `plugins-registry-in-sync`, `plugins-doc-in-sync`, `type-check`, and `eslint`.
