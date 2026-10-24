# Instance-scoped DOM roots: closing the "reaches the whole document" class

## Context

The app mounts the same surface more than once at a time, on three independent axes:

1. **Keep-alive tabs.** `apps-core/tab-surface/web/components/app-tabs-body.tsx` mounts
   *every* open tab at once and hides the unfocused ones with `display:none`. A plain
   ⌘-click on any in-app link (`navigate(url, { newTab: true })`) is enough.
2. **Floating windows.** Several visible simultaneously.
3. **Side-by-side panes.** Miller columns, e.g. `/pages/page/:a/page/:b`.

So a component that reaches for the *whole document* to find something its own instance
rendered can answer with another instance's element. `document.querySelector` returns the
first match in DOM order — which may be a `display:none` background tab's node: all-zero
rects, not hit-testable. The failure is silent and total.

This just produced a bug. Commit `e31750f6b` fixed `rowAtPointer` in the page editor,
which scanned `document.querySelectorAll("[data-block-id]")`; a drag in the right pane
resolved to left-pane rows, so the marquee painted and nothing selected. That was one
call site. This plan closes the class it belongs to.

### Most of the class already has a structural home. One sub-class does not.

| Sub-class | Structural home | State |
|---|---|---|
| Per-instance **state** in a module singleton | `primitives/scoped-store` + `scoped-store/no-module-mutable-store` | Closed (detection deliberately narrow) |
| Per-instance **keyboard** | `primitives/shortcuts` — one global listener, per-descriptor `surfaceId` vs. the focused surface | Closed |
| Per-instance **storage keys** | the `(tabId, paneId)` grammar in `layouts/miller`, `appInstanceKey()` | Pattern exists, unenforced |
| Per-instance **DOM lookup** | — nothing — | **Open** |

The gap is visible in the code: three occurrences, three different hand-rolled answers.

- `page/editor/web/components/block-editor.tsx` — fixed by a **ref it owns**. Works only
  because the asker *is* the owner.
- `conversations/.../jsonl-viewer/web/components/pane-scroll-context.tsx` — fixed by a
  **bespoke 34-line context**. Works only because `JsonlPane` itself holds the node.
- `apps/pages/plugins/page-outline/web/components/page-outline.tsx:64` — **still broken**,
  and its own comment documents the bound: *"two panes showing the SAME page … both
  resolve to whichever row is first in the DOM."* That is rung 5, the weakest.

`PageOutline` has neither prior answer available. It is contributed into
`PageDetail.Overlay`, which `PaneChrome` renders as a *sibling* of the scroller — outside
the `BlockEditor` subtree, deliberately, so the rail does not scroll away. It cannot ref
the node and cannot walk up to it. Publisher and reader share only an ancestor.

**`useSurfaceTabId()` cannot key this.** Miller columns live inside one tab, so two
editors on `/pages/page/:a/page/:a` share a `tabId`. React tree position is the only key
that separates all three axes — which is what a `<Provider>` is.

## Solution

### A new primitive: `plugins/primitives/plugins/scoped-store/plugins/dom-scope/` (web + check)

**Nested under `scoped-store`, not a new top-level primitive.** `primitives/plugins/` is
95 entries deep and `infra/plugins/` is 37 — an unbounded flat list, which is the failure
the root CLAUDE.md's "group related plugins under an umbrella" rule exists to prevent. See
[Placement](#placement-and-a-rule-against-new-top-level-primitives) below for the rule this
plan adds and the structure it points at.

Nesting is also the honest description: `dom-scope` **is** a scoped store — one holding a
single element instead of arbitrary state — and it is implemented as a façade over
`defineScopedStore`. Nesting makes that dependency structural rather than a sentence in a
doc. `primitives/text-editor` and `primitives/data-view` are the precedent: a plugin with
its own runtime barrel *and* a `plugins/` subtree.

Consumers import the child barrel directly
(`@plugins/primitives/plugins/scoped-store/plugins/dom-scope/web`); `scoped-store` must not
re-export its symbols, per the no-cross-plugin-re-exports rule.

> **`dom-scope` = `install-sink`'s discipline × `scoped-store`'s lifetime.**

`install-sink` is the right vocabulary and the wrong lifetime — its own source says so
(`define-install-sink.ts:89`: *"Process-global is the point here"*). Two mounted editors
would fight over one module slot. But three things are inherited from it rather than
reinvented: `{ name, what }` for the throw message; **the only render-path presence
answer is a subscription** (a callback ref fills one commit after the reader's first
render, exactly like a late install); and **the imperative sample is named `peek…`**, so
`install-sink/no-render-phase-peek` — which keys on the callee name and already runs
repo-wide at `error` — guards it for zero new lint code.

```ts
export type DomScopeRoot =
  | { readonly attached: true; readonly root: HTMLElement }
  | { readonly attached: false };

export function defineDomScope<T extends HTMLElement = HTMLElement>(opts: {
  name: string;   // "page.block-content"
  what: string;   // "the block list's content grid (published by <BlockEditor>)"
  bounds: readonly string[];  // ["data-block-id"] — see Enforcement
}): {
  Provider: (p: { children: ReactNode }) => ReactNode;
  usePublishRef(): (n: T | null) => void;      // the owner's callback ref
  useRoot(): DomScopeRoot;                    // the ONLY render-path read; subscribed
  useScopeApi(): { peekRoot(): T | null; peekRootOrThrow(): T };
};
```

Implementation is a ~60-line façade over `defineScopedStore<T | null>(null)`. Reactivity
is entirely delegated: the `Provider` creates state once per mount (that *is* the
multi-instance fix), `usePublishRef()` hands back a callback ref that `setState`s the node,
`setState` bails on an `Object.is`-equal write, and `useRoot()` is `useStore()` →
`useSyncExternalStore`. Use `useStore()` rather than `useSelector()` — the value changes
at most twice per mount, so the selector cache would be noise — and `useMemo` the returned
object on the element so `resolve` callbacks stay referentially stable.

Three design decisions, each argued from a CLAUDE.md rule:

**The reader gets a union, never `HTMLElement | null`.** Three situations must stay
distinguishable: no Provider (a composition bug → **throw**), Provider present but the
owner's node not attached yet (`{ attached: false }`), and attached. A nullable root
merges the last two *at the call site*, because the collapse is one character wide —
`root?.querySelector(sel) ?? null` cannot tell "not attached" from "no matching rows",
which is the absorbable failure the codebase bans. The unattached arm carries **no `root`
field**, so that spelling does not typecheck; the caller must write `attached ? … : …` and
therefore must state what "not yet" means. Rung 2.

**The primitive exposes no query helpers.** A `scope.queryAll(sel)` would have to answer
something when unattached, and every candidate (`[]`, `null`) reintroduces exactly the
absorbable value the union just removed. The primitive's job is to make the root
unambiguous; `root.querySelectorAll(sel)` at the call site is already correct code once
`root` is the right root. Domain helpers belong to whoever owns the DOM contract and take
the root as a **required parameter** — the move `e31750f6b` already made for
`rowAtPointer`. In `page/editor/web`:

```ts
export function blockRowsIn(root: HTMLElement): readonly HTMLElement[]
export function blockRowIn(root: HTMLElement, id: string): HTMLElement | null
```

The required `root` is what closes the class for `data-block-id` at rung 2: there is no
way to call these without narrowing first, and `CSS.escape` is spelled once.

**`usePublishRef()` hands back the callback ref itself, not an object carrying it.**
`react-hooks/refs` reads a `.ref` property access in render as a ref access and cannot
tell this one from a `useRef` handle, so an object shape makes every owner a lint error
at the one place the ref is supposed to go. (Found by the build, after the first draft
returned an object.) An owner needing the imperative sample takes `useScopeApi()` beside
it.

**A missing Provider throws, from both `usePublishRef()` and `useRoot()`.** Rungs 1–3 are
genuinely unavailable — "publisher and reader must share a Provider" is a fact about a JSX
tree assembled across three plugins, not derivable from any type or per-file lint. Rung 4
is the ceiling, and both `scoped-store.useStoreApi` and `SurfaceOverlay` already sit
there; the latter states the principle in the words that apply here: *"`null` means
'nobody declared a surface above me', which is a bug at the overlay, not a mode to degrade
into."* The publisher throwing is what makes it loud: `BlockEditor` is the page body, so a
host that forgets the Provider fails on **every page open** with a message naming the
scope, rather than a right-edge rail quietly not appearing.

The published ref also asserts on a **second** publish into one scope (guarded by
`current.isConnected`, so a legitimate reparent does not trip it). A scope with two roots
has no defined answer and every reader is already wrong.

### Enforcement: derive the ban from the declaration

A blanket "no `document.querySelector*` in `plugins/**/web/**`" rule is the wrong shape.
The audit found ~18 production call sites, of which **one** is a hazard; the rest are
correct — boot mounts, `<head>` style/font management, `document.querySelector("main")`,
and `tab-drag-overlay.tsx:71`'s `[data-floating-window-id="${id}"]`, which is document-wide
*on purpose* because the selector pins a globally unique id. Safe-vs-unsafe turns on
whether the selector pins a unique id, which is not statically decidable. A rule needing
~8 allowlist entries for correct code enforces less than it looks — the argument
`dom-selection-safety`'s own CLAUDE.md makes.

So make the declaration itself the ban. `defineDomScope({ bounds: ["data-block-id"] })`
declares which attributes that scope bounds, and a contributed check
`plugins/primitives/plugins/dom-scope/check/index.ts` —
`dom-scope:bounded-attr-not-document-wide` — collects every declared `bounds` entry in the
tree and fails on any `document.querySelector*` / `getElementById` / `getElementsBy*` whose
selector literal names one, outside the scope's owning plugin. Use `grepCode` /
`listCandidateSources` from `tooling/plugins/checks/core` (they mask comments and strings,
so prose mentioning an attribute cannot false-positive).

This is the answer to "what would make it inexpressible rather than found by grep":
**declaring a scope closes the document-wide loophole for its own attributes, everywhere,
with no list for anyone to maintain.** Adding a scope adds enforcement; nothing to forget.

A check rather than a lint rule because the reasoning is cross-file — a per-file ESLint
`create()` cannot see declarations in another plugin — and because ESLint rules here cannot
import `@plugins/*` at all (jiti cannot resolve the alias). If the derivation proves
fiddly, the fallback is a lint rule holding the attribute list as a literal plus an
`*-in-sync` check keeping it honest, which is the house idiom (`plugins-doc-in-sync`,
`migrations-in-sync`) — but try the derived form first.

## Migration map

| Site | Change |
|---|---|
| `primitives/scoped-store/plugins/dom-scope/` | **New.** `web/index.ts`, `web/internal/define-dom-scope.ts`, `check/index.ts`, `CLAUDE.md`, jsdom tests |
| `primitives/CLAUDE.md`, `infra/CLAUDE.md` | **New prose** above the autogen block: the no-new-top-level-primitive rule (text below) |
| `jsonl-viewer/.../pane-scroll-context.tsx` | **Deleted.** Replaced by a `defineDomScope({ name: "jsonl.pane-scroll", bounds: ["data-event-key", "data-event-index"] })`. Provider moves **up** from `JsonlPaneInner` to `JsonlPane` (a component may not render a Provider and use it in its own body). Drops the `useState` fan-out at `jsonl-pane.tsx:245-255`, so attaching the scroller no longer re-renders the transcript. Two consumers re-point: `jsonl-viewer/plugins/outline`, `jsonl-viewer/plugins/transcript-stats` |
| `page/editor/web` | Declare `blockContentScope` (`bounds: ["data-block-id"]`); add `blockRowsIn` / `blockRowIn` to the barrel |
| `page/editor/.../block-editor.tsx` | `contentRef` (577) becomes the publish handle; `ref=` at 1760 becomes `ref={content.ref}`; the ~5 `contentRef.current` reads become `peekRootOrThrow()` (all sit in pointer handlers, where "my own div is unmounted" is impossible — the `if (!content) return []` absorbable empty at 595-600 goes away). `rowAtPointer` itself is untouched; it already takes its rows |
| 3 `<BlockEditor>` hosts | Mount `<blockContentScope.Provider>`: `pages/page-tree/web/panes.tsx:198` (wrapping `<PaneChrome>` in `PageDetailBody`), `story/plugins/shell/.../story-editor.tsx:48,58`, `website/.../editor-toy.tsx:64`. The editor already has this convention — `FrameHoverProvider` is mounted by each surface around its block list |
| `pages/page-outline/.../page-outline.tsx` | **The live fix.** `resolveBlockRow` (63-65) deleted; `resolve` becomes `content.attached ? blockRowIn(content.root, id) : null`. Delete the "Known bound" comment and the matching `## Known bound` section of its `CLAUDE.md` |

**Sequence:** ship the primitive → migrate `jsonl-viewer` first (self-contained, two
existing consumers, currently *works* — so a wrong API shows up here rather than on top of
a live bug) → `page/editor` → `page-outline` → the check. Cross-link the CLAUDE.mds of
`scoped-store`, `install-sink`, and `auto-scroll` (whose `findScrollParent` answers the
*other* question — "the scroller I am inside" — and must not be reached for here).

## Placement, and a rule against new top-level primitives

`plugins/primitives/plugins/` holds **95** entries and `plugins/infra/plugins/` holds
**37**, both flat. Adding a 96th by reflex is how a category stops being a category. Both
CLAUDE.mds are currently nothing but their autogenerated block, so this prose goes in
above it — the same shape every other plugin CLAUDE.md has.

### Rule text (paste into `plugins/primitives/CLAUDE.md`, above the autogen block)

```md
## Do not add a new top-level primitive without approval

`plugins/primitives/plugins/` is 95 entries and flat. That is an unbounded list, not
the set of semantic categories the root CLAUDE.md's "group related plugins under an
umbrella" rule asks for, and every reflexive addition makes it worse.

**Never create `plugins/primitives/plugins/<new-name>/` on your own initiative.** Ask
in the current conversation and wait for a yes. Approval from a previous session, or
for a different primitive, does not carry.

Instead, in order of preference:

1. **Extend the primitive that already owns the concept.** A new export on an existing
   barrel is almost always the right size. Search `docs/plugins-details.md` first.
2. **Nest under the primitive you are built from.** A plugin may have both its own
   runtime barrel and a `plugins/` subtree — `text-editor` and `data-view` both do. If
   your new thing is a façade over, or a specialisation of, an existing primitive, it
   belongs underneath it: the nesting states the dependency instead of describing it.
3. **Propose an umbrella** that takes the new plugin *and* the existing ones it belongs
   with, so the entry count goes down rather than up.

If none fit, say so and ask — naming the two or three placements you considered and why
each fails. A new top-level entry is the owner's call, never a default.
```

`plugins/infra/CLAUDE.md` gets the same text with "primitive" → "infra plugin",
`plugins/infra/plugins/`, and "37 entries". Its step 1 should point at `spawn`, `paths`,
`endpoints`, and `jobs` as the usual right homes.

### Where `dom-scope` goes

`plugins/primitives/plugins/scoped-store/plugins/dom-scope/` — step 2 of the rule. It is a
scoped store holding one element, implemented as a façade over `defineScopedStore`, so the
nesting is the truth rather than a filing decision. Zero refactor, and when the umbrella
below lands, the pair moves as a unit.

### The structure this points at (sketch — not this plan's work)

The right end state is a handful of semantic umbrellas. The one that matters here:

**`primitives/scope/`** — *which mounted instance does this belong to, and how do I reach
mine?* Takes `scoped-store` (my instance's **state**), `dom-scope` (my instance's **DOM
node**), `surface-id` / `tab-id` / `app-instance` (the **ids** that name an instance), and
`install-sink` (the deliberate opposite — one implementation for the whole page). That
grouping is exactly the sub-class table at the top of this document, which is a good sign
it is a real category and not a filing convenience.

Others that fall out of the same list, sketched only:

- **`dom/`** — `dom-selection`, `element-size`, `in-view`, `auto-scroll`, `overscroll-hint`,
  `scroll-reveal`, `copy-source-text`
- **`overlay/`** — `popover`, `imperative-dialog`, `cursor-menu`, `floating-surface`,
  `floating-action`, `surface-overlay`, `overlay-boundary`, `tooltip`, `popup-open`
- **`collections/`** — `data-view`, `data-table`, `tree`, `virtual-rows`, `sortable-list`,
  `rank`, `rank-reorder`, `multi-select`, `cursor-pagination`, `keyset`, `row-actions`
- **`text/`** — `text-editor`, `prompt-editor`, `markdown`, `inline-text`,
  `syntax-highlight`, `file-links`, `diff-view`, `editable-field`, `collab-doc`
- **`chrome/`** — `bar`, `app-shell`, `breadcrumb`, `section-card`, `view-switcher`,
  `tabbed-view`, `adaptive-bar`, `action-presentation`, `avatar`, `icon-button`

and for `infra/`: **`host/`** (`host-admission`, `host-read-pool`, `contention`, `duress`),
**`git/`** (`git-watcher`, `git-read-cache`), **`process/`** (`spawn`, `ssh`, `launcher`),
**`store/`** (`attachments`, `secrets`, `trash`, `retention`).

Each move is mechanical but touches every importer, so it wants to be its own task per
umbrella, run when nothing else is mid-flight. Worth filing `primitives/scope/` as the
first one, since this plan creates two of its five members.

## Out of scope — file as separate tasks

The audit found four more live bugs in the sibling sub-classes. Each is independent of
this change and should be its own task, not bundled in:

- `primitives/css/plugins/ui-kit/web/components/ui/sidebar.tsx:107` — a `window` keydown
  for ⌘B with no focus check. Two mounted app shells ⇒ one press toggles both sidebars.
  Fix: `useSurfaceShortcuts` from `primitives/shortcuts`, which already gates on the
  focused surface.
- `primitives/tree/web/internal/pending-focus.ts:5` — a module-global "which row focuses
  next" flag with **no key at all**. Two mounted `TreeList`s steal each other's pending
  focus.
- `conversations/plugins/pane-restore/.../pane-restore-store.ts:41` — storage keyed
  `route.restore.<convId>`, per-entity not per-surface. Two panes on one conversation
  clobber each other's restored sub-route. Fix: compose `useSurfaceTabId()` into the key,
  the `layouts/miller` `(tabId, paneId)` pattern.
- `primitives/view-switcher/web/internal/use-active-view.ts:37` — `${storageKey}:active-view`
  is only as scoped as the caller's id; `data-view` and `tabbed-view` pass unscoped ids, so
  two panes on one view id share an active tab.

Also worth a doc sentence, not a task: `PageDetail.Overlay`'s own comment should say the
overlay layer must stay inside the pane body's React tree. If it ever portals to the app
shell there is no common ancestor and the scope has nowhere to mount.

## Verification

1. `./equin build` (background — see CLAUDE.md), then confirm `status: ok` in
   `~/.singularity/worktrees/<wt>/build-status.json`.
2. `./equin check` — the new `dom-scope:bounded-attr-not-document-wide` must pass,
   and must **fail** if you temporarily restore `page-outline`'s `document.querySelector`.
3. `./equin test plugins/primitives/plugins/dom-scope` — jsdom tests asserting: two
   `<Provider>`s side by side give each reader its own root; no Provider throws; two
   publishers in one Provider throws; a reader that renders before the owner attaches
   re-renders on attach (the late-fill case).
4. **The e2e that proves the live fix** —
   `plugins/apps/plugins/pages/plugins/page-outline/e2e/two-pane-outline-verify.ts`,
   modelled on `page/editor/e2e/two-pane-selection-verify.ts` and carrying the same
   state-the-hazard-directly assertion, so it cannot pass for the wrong reason.
   **13/13 passing.** Two notes for whoever edits it:
   - Assert on the **heading's own viewport rect**, not a scroller's `scrollTop`.
     Which element scrolls is pane-chrome detail, and "first ancestor that overflows"
     resolved to a different node in each pane (1467px vs 4539px of overflow for the
     same document), so the scrollTop version failed in both panes for a reason that
     had nothing to do with the feature.
   - Seed **few long paragraphs, not many short lines**. An earlier version typed ~40
     blocks at 60ms and raced the editor into seeding one heading instead of three; the
     script now asserts the seed before anything depends on it.
5. Manual: ⌘-click a page link to open a second tab of the same page, focus it, confirm the
   outline rail is live (pre-fix, it resolves to the hidden tab's zero-rect rows and dies).

## Risks

- **A portal would remove the need for the primitive** — the strongest alternative.
  `PageDetail.Overlay` contributions could render *inside* the editor subtree and portal
  out, as `SurfaceOverlay` does, making the outline a React descendant while staying a DOM
  sibling. Rejected because it inverts the slot's ownership (a reading-progress bar has no
  business being a child of the block editor), it does not generalize (each new case needs
  its own portal host), and `jsonl-viewer`'s publisher is already the pane, so a portal fix
  there is a no-op and we would keep two mechanisms. A reviewer could reasonably take this
  fork.
- **The named registry has a layering cost.** The declaration must live in a plugin below
  both parties. Free here (`page/editor` is below `page-tree` and `page-outline`), but a
  future pair with no common lower plugin needs a leaf created to hold it — which is
  exactly why `primitives/surface-id` exists.
- **The double-publish assert could false-positive** on a reparent React does as
  attach-then-detach. `isConnected` covers the ordinary cases, but a throw here white-screens
  the editor. If it proves flaky, downgrade to `primitives/report-sink` — a precedent this
  plugin already uses twice.
- **Nested editors.** Today inline sub-page expansion is a *composite store inside one
  editor*, not a nested `BlockEditor`, so there is no second publisher. The day a block type
  embeds `<BlockEditor persist={false}>` it must wrap itself in its own Provider — the
  assert is what teaches it to. Do **not** make `BlockEditor` mount its own Provider
  automatically: that would put the outline outside the editor's scope and break the fix.
- `story-editor.tsx` has two `<BlockEditor>` call sites (48, 58) — confirm they are
  branches of a conditional, not two simultaneous editors, before placing the Provider.
