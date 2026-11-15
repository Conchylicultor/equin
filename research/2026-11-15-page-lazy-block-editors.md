# Page editor: mount cost per block, not per visible/edited block — design (decision pending)

Task: task-1794734284-dsg300 (follow-up of task-1794732771-gu0udt, report-1794458547-ysdj00;
report-1794732984-y4wspi is the Supervisors-pane click landing on the same open).

## Context

Opening a long page beside a conversation (`conversation/page-detail`) mounts one full
Lexical editor per text block — `BlockTextRenderer → BlockTextEditor` (LexicalComposer +
RichTextPlugin + `ServerCollabTextPlugin` / `useCollabBlockDoc` Yjs binding + every contributed
block-text plugin: `/` menu, `[[`, `@`, `$$`, url-paste, link hover, format toolbar, markdown
shortcuts) — whether the block is on screen or not.

## Measurements (2026-11-15)

Fixture: page `block-3cd6b48c-…` (300 rows, **208 live Lexical editors**, 190 inline chips;
5.8k elements in the page pane, 17.1k in the document), opened from ended conversation
`conv-1794732771-vhu9io`, with `plugins/page/plugins/editor/e2e/open-in-conversation-profile.ts`.
Headless Chromium, darwinbg tier, so the absolute values are inflated by roughly 1.5–3×. The
ratios hold.

The open is about 4 long frames: 218 / 406 / 132 / 58 ms, **≈ 810 ms**, of which ≈ 600 ms is
script. The CPU profile splits that script time into:

| part | ms | per editor | scales with |
|---|---|---|---|
| React render of the block tree (components + reconcile) | ~146 | ~0.7 | blocks |
| Lexical mount updates: `$beginUpdate → $internalCreateRangeSelection` reading `window.getSelection()` | **~100** | ~0.48 | editors |
| Miller column swap ghost: `cloneWithScroll(column)` full copy → `carryScroll` lays out the clone | **87–117** | — | size of the replaced column |
| Forced style in the commit (first reader: outline `findScrollParent`) | ~90 | — | DOM size |
| Forced layout in the after-layout phase (first reader: breadcrumb `useAncestorCollapse`) | ~63 | — | DOM size |
| Yjs `ingestServerState` + binding sync | ~30 | ~0.15 | editors |
| `[[` menu's recent-pages subscription (closed menu) | 11–18 → **~1** | — | fixed in this task |

**Why a Lexical mount reads the DOM selection.** In Lexical 0.53, every update of a non-headless
editor calls `$internalCreateSelection`. With no event and no previous selection, that function
always reads `window.getSelection()` (`getDOMSelectionPoints`), even when the selection is
nowhere near this editor. In Chromium, reading `Selection.anchorNode` / `rangeCount` /
`getComposedRanges` after a DOM write costs 0.24–0.29 ms on this page, even when the document has
no selection at all (`type: "None"`). I measured this in the page: 200 append-then-read iterations
gave 0.2875 ms per `anchorNode` read and 0.0005 ms for a no-op. Each editor's reconcile writes the
DOM, and the next editor's update then reads the selection, so this cost is paid once per editor.

## The root cause

The page treats "a block exists" as "a block is being edited". Every per-block cost above
(React subtree, Lexical instance + selection read, Yjs binding, plugin hooks, ~28 DOM elements)
is paid for 208 editors when the user edits at most one, and sees at most ~30.

The code already expects some blocks to be unmounted, so the model does not assume every block
is live:

- `caret-authority`: a landing on a block with no handle becomes a flight that waits for its
  handle to register. Keystrokes typed meanwhile are buffered and replayed.
- `mergeBlock` has an "Unmounted target (virtualized offscreen)" branch that writes through
  `spliceStoredBlockDoc` (a doc edit with no editor).
- `plugins/page/plugins/read-only-view` (`ReadOnlyBlocks`, `RunsRenderer`) renders the same
  blocks through the same `TextBlockLayout` and block registries without Lexical. It is already
  used by history previews, trashed pages and table cells.
- The server→client doc push is already page-level (one `pageBlockDocs` tuple per page). Only the
  per-block `Y.Doc` sessions are per editor.

## Options

### A. Static by default, mount the editor on intent (recommended)

Every text block renders through `RunsRenderer` inside the same `TextBlockLayout`, so the line
looks the same. The block mounts its `BlockTextEditor` when an edit intent targets it:

- pointerdown or focus on the line
- a caret landing (`land` / flight)
- a span end
- a structural op that needs live runs

Once mounted it stays mounted while it is focused, plus an LRU of a few recent editors. The
caret lands through the existing flight, which already buffers and replays input. The click
offset comes from `caretPositionFromPoint` on the static DOM, then `focusOffset`.

- **Cost:** O(edited) Lexical instances. The open pays the static render, which I estimate at
  ~0.2 ms per block against ~1.5 ms; I have not measured it. That removes the ~100 ms selection
  reads, the ~30 ms Yjs sync and most of the ~146 ms render. Remote edits to a static block show
  through the row's `data.text` projection (lagged ≤ 1 s), or through the block doc owner if it is
  held page-wide.
- **Touches:**
  - The focus-handle API needs a static half for the reads (`readRuns` from data,
    `domRangeOf` / `offsetAtPoint` over the `RunsRenderer` DOM).
  - Text spans: `spanForest` and `spanEndRuns` currently throw on an unmounted end, and
    `span-motion` returns wrong offsets for one.
  - `text-span-highlight` silently skips unmounted lines today. It needs static ranges.
  - Find-in-page is unaffected (the text is in the DOM).
  - Every block plugin's chrome must render in both modes. `read-only-view` already requires
    this.
- **Risks:**
  - A flash when a line swaps from static to live, if the two renderings differ by a pixel. The
    shared `TextBlockLayout` is there to prevent this, and a pixel diff can verify it.
  - The first keystroke into a just-mounted line. The flight's buffer covers it.
  - IME / composition starting on a static node.
  - Native selection that starts in a static line. This is arguably simpler than today: plain
    DOM, no 208 contenteditables.

### B. Viewport-gated mount (IntersectionObserver ± margin)

This uses the same static/live split as A, but blocks within the viewport plus a margin mount
live.

- **Cost:** about the number of visible blocks (~30–50) instead of 208.
- **Drawbacks:**
  - Fast scrolling pays mounts mid-scroll (~1.5 ms × rows entering).
  - It keeps every static-mode requirement of A anyway, because off-viewport blocks are static.
- Strictly more machinery than A, for less saving. It only makes sense if a hover affordance must
  be live everywhere.

### C. One shared Lexical editor per page

This would replace the per-block Lexical + per-block `Y.Doc` model with one document. It rewrites
the collab model, block registries, caret authority and every block plugin. Not recommended:
A gets the cost without changing the data model.

### D. Shrink the per-editor constant (complements A or B, does not replace them)

- **D1.** Patch Lexical (a `patches/lexical@0.53.0.patch`, plus an upstream PR) so a mount update
  does not read the DOM selection when the editor cannot own it. That is: no previous selection,
  no event, and the root does not contain `document.activeElement` or the selection's anchor.
  This needs a cheap pre-check that does not itself read `Selection`. Saves ~100 ms here. It
  changes core selection semantics in a third-party library (risk: a programmatic selection in an
  unfocused editor).
- **D2.** Skip the closed menus' surfaces. Each caret menu (`/`, `@`, `$$`, url-paste) still
  mounts a closed `FloatingSurface` + `useCaretMenu` per block (~5–8 ms in total). The same
  "mount the menu only while open" split as the `[[` fix applies, at the primitive level (see
  Follow-ups).

## Not per-block, in the same frame (follow-ups, filed separately)

- **Miller swap ghost.** `column-motion.tsx` copies the replaced column whole (`cloneWithScroll`
  without `visibleOnly`) and lays the copy out to carry its scroll. That costs 87–117 ms here. A
  ghost is a picture: `visibleOnly` (as `window-snapshot` already uses) would bound it by what was
  on screen.
- **Two forced full style/layouts per open** (~90 ms + ~63 ms). Each is the first reader of a
  dirty tree. The fix is to batch the commit-path reads behind the after-layout phase, so the
  frame's own style/layout pays it once.

## Landed in this task

`[[` page-link menu: the plugin only derives the trigger (`useCaretQuery`). The menu (pages read,
keyboard commands, surface) mounts while the trigger is open. This took `InlinePageLinkPlugin` from
11–18 ms inclusive to ~1 ms, and `useLive` from 31–35 to 21–30 ms on the open. I verified it with a
scripted run: no closed menus were mounted, `[[Sup` opened the menu with results, and ArrowDown +
Enter inserted the second page.

## Verification for A (when chosen)

- `open-in-conversation-profile.ts` on the same fixture: target fewer than 10 live editors and the
  opening frame under ~250 ms headless.
- The existing editor e2e suite (`plugins/page/plugins/editor/e2e/*-verify.ts`: caret, span,
  clipboard, crdt, drag, merge/split), every one passing.
- An exhibit pixel diff, static vs live, for each text block type.
