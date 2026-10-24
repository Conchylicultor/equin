# The caret authority: input follows the model, not the DOM

## Context

Typing in the pages editor silently corrupts content. Typing words separated by
Enter with no artificial delay reproduces reliably:

```
typed:  "alpha" Enter "bravo" Enter "charlie" Enter
got:    ["alphab", "ravoc", "harlie"]
```

Each word's FIRST character stays behind in the previous block. It reproduces
under host load (observed at load average ~20–24 on 18 cores) and is not specific
to any block type.

### Why it happens

`focusNew` (`web/block-editor-context.tsx:1088`) cannot focus the new block —
it does not exist yet — so it arms `pendingFocusRef`. The caret only lands when
the new `BlockTextEditor` mounts and its **passive** `useEffect`
(`web/components/block-text-editor.tsx:138`) calls `registerFocusHandle`, which
fires the queued focus.

React flushes passive effects in a **separate scheduler task**, while keydown
events arrive from the browser's higher-priority *user-interaction* task source.
So the keystroke is structurally favoured to arrive first; the only reason it
usually doesn't is that humans type slower than React schedules. Under load the
scheduler task is delayed and the gap grows without bound. Every keystroke in the
gap is delivered to the **origin's** contenteditable — already truncated, caret at
the cut point — producing `"alphab"`.

The `~20ms` in the editor's CLAUDE.md ("beyond human input") is the typical length
of that gap on an idle machine, not a bound. Nothing in the code bounds it.

### Why this is not a focus-timing bug

Each block is its own editing host, so "where is the caret" is answered by
`document.activeElement` plus the DOM selection. The editor never *owns* that
answer — it only issues requests (`focusBlock` / `focusNew` / `pendingFocusRef`)
and waits for the browser to agree. In the stretch where the model says B and the
browser says A, **the browser routes input and the editor has no way to object.**

The tell is that the editor's CLAUDE.md already documents *four independent*
hardening mechanisms defending this one seam:

- `SKIP_DOM_SELECTION_TAG` on the origin's truncation — stops the old block's
  reconcile from yanking focus back.
- `releaseCaret` — stops a caret parked in a blurred block letting a reconcile
  steal focus.
- The block-selection `e.target`-never-`activeElement` rule — `activeElement` is a
  TOCTOU because focus moves mid-dispatch.
- `focusHydratingAware` — focus must be taken before the target has content to
  hold a caret.

Four mechanisms, one cause: DOM focus is the source of truth for something the
editor must control and cannot update atomically with its own model. That is a
missing abstraction, not four bugs.

### The invariant this establishes

> The editor holds **one authoritative caret location**. It moves **synchronously**
> with the keystroke that moves it. DOM focus is a **projection** of it — never the
> source of truth, and never consulted to decide where input goes.

Once it holds, "the target hasn't mounted" stops being a race and becomes an
ordinary state: the caret is at `(blockId, …)`, that block's host isn't ready, so
input queues against the model and applies when it arrives. Nothing can be
misrouted, because nothing consults the DOM to route.

This closes every caller at once — split, `insertAfter`, undo/redo's deferred
focus restore (`block-editor-context.tsx:663`), a target inside a collapsed
ancestor, a lazily-loaded block type — not just Enter.

### Explicit non-goal

Making the landing synchronous (`flushSync` + layout-effect registration) is a
*different* fix, considered and deferred. It would only shorten the buffered
window; it cannot satisfy the invariant (it can't cover collapsed ancestors,
deferred undo focus, or a Suspense-fallback row), and it rests on
`@lexical/react`'s `CollaborationPlugin` pre-seeding the doc in a passive effect
that runs before ours — inverting that order trades misplacement for silent
*loss*. It can be layered on later purely to reduce latency.

---

## Design

### 1. The authority — `web/internal/caret-authority.ts` (new)

`pendingFocusRef` is promoted from *"a note about who to focus later"* into the
object that owns input routing. Two states:

- **`idle`** — model and DOM agree. The authority does nothing; the browser types
  natively (crucially: IME, dictation and autocorrect keep working, because they
  need a real focused editing host).
- **`inFlight { targetId, land, buffer }`** — the model has moved, the DOM hasn't.
  The authority owns the keyboard.

```ts
type FlightInput =
  | { kind: "text"; text: string }
  | { kind: "key"; key: KeystrokeKey; shift: boolean };

interface CaretAuthority {
  /** Land the caret in `blockId`. Synchronous when its host is mounted; a
   *  claim (flight) when it is not. `land` is the caller's landing policy —
   *  plain focus / focusOffset / focusBoundary — so every existing caller keeps
   *  its exact semantics. */
  land(blockId: string, land: (h: BlockFocusHandle) => void): void;
  /** The block list hands the authority its interaction surface. */
  attachContainer(el: HTMLElement | null): void;
  registerHandle(id: string, handle: BlockFocusHandle): () => void;
  /** Push-based bound: called on each authoritative snapshot. */
  reconcile(liveIds: ReadonlySet<string>): void;
}
```

`focusHandlesRef` moves **inside** the authority and stops being reachable from
the provider. That is the enforcement mechanism: there is no way to focus a block
except through `land()`, so a future caller cannot reintroduce the gap. No lint
rule needed — it is a type-level fact.

### 2. Taking the keyboard (why the caret parks on the container)

On claim the authority does **not** leave focus in the origin and defend it with
`preventDefault`. Defending is not airtight — `beforeinput` with
`insertCompositionText` is not cancelable, so an IME could still write into the
block the user left. Instead:

1. `releaseCaret(container)` — drop the DOM selection.
2. `container.focus({ preventScroll: true })` — the block-list container is
   already `tabIndex={-1}` (`web/components/block-editor.tsx:1199`).

The origin is no longer an editing host, so **nothing can enter it** — not typing,
not IME, not paste, not spellcheck autocorrect. This reuses the mechanism
`releaseCaret` already exists for, and composes with the documented reconcile-steal
hazard instead of fighting it: with no caret parked in the origin, its
`SKIP_DOM_SELECTION_TAG`-tagged truncation has nothing to yank back.

Lift `releaseCaret` out of `use-block-selection.ts:95` (currently module-local)
into the authority module and have block-selection import it — one definition.

### 3. Capturing intent

While in flight, native **capture-phase** listeners on the container (capture runs
root→target, so they precede Lexical's own listeners on each contenteditable) plus
`stopPropagation()` (so React's delegated `onKeyDown` on the container — the
block-selection policy — never sees them):

- `keydown` — `ctrlKey`/`metaKey` pass through untouched (shortcuts, Cmd+Z,
  clipboard). The eight `KeystrokeKey`s (`keystroke-intent.ts:20`) buffer as
  `{kind:"key"}`. Everything else falls through to `beforeinput`.
- `beforeinput` — `insertText` / `insertReplacementText` buffer `e.data`;
  `insertFromPaste` buffers the plain text off `e.dataTransfer`. (Composition
  cannot occur: the container is not an editing host.)
- Focus leaving the container aborts the flight (§5).

### 4. Landing and replay

The landing needs a *caret-ready* signal, not merely a mounted handle: a freshly
split block's Lexical root is childless until the collab pre-seed lands, and
`editorState: null` + `shouldBootstrap={false}` mean there is nothing to insert
into. `focusHydratingAware` (`web/internal/collab-text-surgery.ts:149`) already
distinguishes exactly these two cases — it just doesn't tell anyone.

- Add `onLanded?: () => void` to `CaretLandOptions` (`web/caret-surface.ts:12`).
  `focusHydratingAware` invokes it in **both** branches: immediately after
  `focusRestoringSelection` on the non-empty path, and from the existing one-shot
  update listener on the hydrating path.
- Add `replayInput?(entries: FlightInput[]): void` to `BlockFocusHandle`
  (`block-editor-context.tsx:187`), implemented in `block-text-editor.tsx` where
  the Lexical instance is in scope:
  - consecutive `text` entries coalesce into one
    `editor.update(() => selection.insertText(joined))`;
  - a `key` entry dispatches the matching Lexical command with a synthetic
    `new KeyboardEvent("keydown", { key, shiftKey })` —
    `KeyboardPlugin.handle` (`keyboard-plugin.tsx:150`) accepts
    `KeyboardEvent | null` and only needs a real object, so replay flows through
    the *same* resolver as a real keystroke. `preventDefault()` on an untrusted
    event is a harmless no-op.

Replay is sequential, so a replayed `Enter` re-enters `split()` and claims the
next flight — the queue composes with no special case.

### 5. Failure is a state, not a silence

The flight is bounded **push-based**, not by a timer: `reconcile(liveIds)` runs on
each authoritative blocks snapshot, and a flight whose `targetId` is absent from
server truth after the op's confirming push is a failed landing.

On abort: **replay the buffer into the origin block** (the user loses nothing —
their text goes back to the block they were standing in) and emit through
`defineReportSink` (`@plugins/primitives/plugins/report-sink`) so it reaches
Debug → Reports rather than being absorbed. Aborting on focus leaving the
container does the same.

### 6. Call-site changes

`focusBlock` / `focusNew` / `focusBlockBoundary` / `registerFocusHandle`
(`block-editor-context.tsx:559-611`, `:1088`) become thin wrappers over
`land()` / `registerHandle()`. Their public behaviour is unchanged; the
`pendingFocusRef` slot and its handle-miss branch are deleted.
`block-editor.tsx` calls `attachContainer(containerRef.current)`. In-memory mode
(`useMemoryBlockStore`) needs no changes — it shares the provider.

---

## Files

| File | Change |
|---|---|
| `web/internal/caret-authority.ts` | **new** — the state machine, capture listeners, buffer, replay, abort; owns `focusHandlesRef` and `releaseCaret` |
| `web/block-editor-context.tsx` | delete `pendingFocusRef` + `focusHandlesRef`; `focusBlock`/`focusNew`/`focusBlockBoundary`/`registerFocusHandle` delegate; `BlockFocusHandle` gains `replayInput` |
| `web/caret-surface.ts` | `CaretLandOptions` gains `onLanded` |
| `web/internal/collab-text-surgery.ts` | `focusHydratingAware` fires `onLanded` on both branches |
| `web/components/block-text-editor.tsx` | implement `replayInput` |
| `web/components/block-editor.tsx` | `attachContainer(containerRef)` |
| `web/internal/use-block-selection.ts` | import `releaseCaret` instead of defining it |

## Removing the workarounds

The 150ms settles are a symptom of this bug and come out with it:

- `e2e/copy-paste-verify.ts:36-49`, `e2e/paste-optimistic-verify.ts:42-48`,
  `e2e/cross-block-text-selection-verify.ts:36-53` — drop the "settle either side
  of the Enter" pauses and their comments.
- Add `typeLines(page, lines)` to `e2e/support/` (exported from `e2e/index.ts`),
  so no script re-implements the loop and no one can re-add a settle in one place
  only. `block-selection-verify.ts:28-33` and `no-collab-cursors-verify.ts:104-118`
  (which never had the guard) adopt it too.
- Delete `plugins/page/plugins/editor-collab/e2e/split-typing-window-probe.ts` —
  superseded by the gate below.

## Verification

1. **Unit (jsdom), the deterministic long-window case** —
   `web/__tests__/caret-authority.test.tsx`: claim a flight for a block whose
   handle is withheld, dispatch text + an `Enter` at the container, then register
   the handle. Assert: the origin received **nothing**, the target received the
   buffered text **in order**, and the replayed `Enter` claimed a second flight.
   Plus the abort path: reconcile without the target ⇒ buffer replays into the
   origin and one report is emitted.
2. **Unit** — `bun test plugins/page/plugins/editor/core` and
   `bun run test:dom plugins/page/plugins/editor` (the existing
   `structural-undo.test.tsx` / `block-selection.test.tsx` guardrails must stay
   green — the authority must not perturb undo or selection).
3. **E2E gate (new)** — `e2e/split-typing-verify.ts`: the exact repro, zero
   `delay`, no settles, **asserting** `["alpha","bravo","charlie"]`. This is a
   pass/fail gate, unlike the probe it replaces. Note it only proves the fast
   path on an idle box; step 1 is what proves the slow one.
4. **Under load** — rerun the gate with the box loaded (e.g. several concurrent
   `./equin build`s) to reproduce the original conditions.
5. `./equin build`, then type fast in a real page at
   `http://att-1785419906-llfn.localhost:9000/pages` and confirm the text is
   intact; `./equin check`.

## Docs

Replace the "Residual known edge: a keystroke landing < ~20ms after Enter can
still be dropped (beyond human input …)" sentence in the Hardening section of
`plugins/page/plugins/editor/CLAUDE.md` with a new top-level section, **"The caret
authority (input follows the model, not the DOM)"**, stating the invariant, why
the caret parks on the container rather than defending the origin with
`preventDefault` (the non-cancelable composition hole), why the landing waits for
caret-ready rather than mount, and that `focusHandlesRef` is deliberately
unreachable outside the authority.
