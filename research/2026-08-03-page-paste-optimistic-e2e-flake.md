# Paste's optimistic spec waits for one thing and asserts another

## Context

`plugins/page/plugins/editor/e2e/paste-optimistic-verify.ts` fails intermittently
— observed 2 runs in 4 — on `the optimistic rows carry the pasted content`, with
`got ["","",""]`. Its neighbours in the same script, and its reload check, pass
every time, and it reproduces on runs unrelated to any write-path change.

This script is the executable spec for optimistic paste: the claim that a
25-block paste is on screen on the keystroke rather than after a 561-789ms
round-trip. A spec that fails half the time cannot distinguish "paste is broken"
from "the assertion read too early", so it stops being cited and the coverage it
was written to provide is lost. The goal is to make it a reliable signal without
weakening what it proves — and, where it is cheap, to make it prove more.

## Root cause: two milestones, polled as one

An optimistic block gesture lands in **two** moments, not one:

1. **The row** comes from the structural overlay — on screen in the commit that
   applies the `BlockOp`. The minted rows carry real `data.text` from the very
   first render (`planForestInsert` copies it verbatim off the clipboard forest),
   so the row is never waiting on content *data*.
2. **The text** appears one scheduler tick later. `LexicalComposer` mounts with
   `editorState: null` + `shouldBootstrap={false}`, so its first commit is an
   empty root — that is the commit that paints. The seed is applied by
   `LiveStateYjsProvider.connect()` → `preApplySeed()`, which is fully
   synchronous and needs no server (an unconfirmed block pre-seeds — see the
   *Hardening* section of
   [`plugins/page/plugins/editor/CLAUDE.md`](../plugins/page/plugins/editor/CLAUDE.md))
   — but `connect()` is invoked from `CollaborationPlugin`'s **passive
   `useEffect`**, which React runs only after the mounting commit has painted.

So the gap is a React commit → passive-effect boundary, not a network gate.
Usually sub-frame, but React may defer passive effects, so it has no upper bound
worth betting an assertion on. And it is invisible: nothing in the DOM
distinguishes "row mounted, text not yet hydrated" from "hydrated and genuinely
empty" — `data-lexical-editor` is stamped either way, there is no `aria-busy` or
`data-hydrating`, and the block's placeholder is gated on the optimistic row's
`data.text` (non-empty here from the first render), so it answers a content
question, not a hydration one. **There is no readiness signal to wait on; the
content itself is the only observable**, which is what makes polling on the
asserted value the fix rather than a workaround.

The script polls for milestone 1 and then asserts milestone 2:

```ts
for (let i = 0; i < 400; i++) {
  if ((await blockTexts()).length > before) { renderedAt = …; break; }  // rows
  await page.waitForTimeout(20);
}
…
const optimistic = await blockTexts();                                  // text
r.eq("the optimistic rows carry the pasted content", optimistic.slice(…), […]);
```

The loop exits on the first observation with more rows, then a *second*
observation reads the text. Whether the text has hydrated in the gap between the
two reads is a race, and `["","",""]` is that race lost.

Two consequences beyond the flake, both worth fixing while here:

- **The timing assertion is weaker than it reads.** `renderedAt < STALL_MS / 2`
  is satisfied by 13 *empty* boxes appearing. "Paste rendered before the server
  answered" is currently only a claim about structure.
- **Content is asserted on 3 of the 13 pasted rows** (`slice(before, before + 3)`),
  so a partial-hydration regression in the other 10 passes.

### The fix already exists in the sibling script

`duplicate-verify.ts` hit this exact race and solved it, naming the mechanism:

> Two separate milestones, because they answer two separate questions and a
> clone's ROW lands a beat before its TEXT does: the row comes from the
> structural overlay, the text from the clone's content doc pre-applying its
> `data.text` seed once its editor mounts. **Both must beat the server, or the
> "optimistic" claim only covers empty boxes.**

`drag-reorder-verify.ts` independently reached the same shape (it polls until the
full text array equals `want`). Paste is the one of the three that was never
updated. So this is not a new design — it is applying a precedent the plugin
already carries, and then putting it somewhere it cannot drift again.

## The change

### 1. One home for the two-milestone wait — `e2e/support/optimistic.ts` (new)

The rule ("an optimistic gesture has two milestones; the wait's predicate must BE
the assertion") is a page-editor fact — structural overlay vs per-block content
doc — so it belongs in the editor's `e2e/support/`, not in `framework/tooling`
(which must not know the Pages app). Shape:

```ts
export interface DocumentMilestones {
  /** ms from the gesture to the first read with more rows than `grewBeyond`; -1 if never. */
  rowsAt: number;
  /** ms from the gesture to the first read equal to `expected`; -1 if never. */
  textAt: number;
  /** The last observation — equals `expected` unless the deadline elapsed. */
  last: string[];
}

export async function awaitDocument(
  page: Page,
  read: () => Promise<string[]>,
  opts: {
    expected: string[];
    timeoutMs: number;
    /** Row count before the gesture. Omit to skip the structural milestone. */
    grewBeyond?: number;
    /** Gesture start, so both milestones are measured from the keystroke. */
    startedAt?: number;
    pollMs?: number; // default 20
  },
): Promise<DocumentMilestones>;
```

One loop, one `read()` per iteration feeding both milestones, exiting on equality
or the deadline. Returning `last` (rather than throwing) is load-bearing: on
timeout the caller's `r.eq` prints a real got/want diff instead of a bare
timeout, which is what makes a genuine paste regression diagnosable.

Reuse note: `packages/retry`'s `retryUntil` is a generic deadline poller and is
legally importable from `e2e`, but it yields a single value — it cannot observe
an intermediate milestone on the way. Build the loop here; do not force it.

### 2. `paste-optimistic-verify.ts` — wait for what it asserts

- `before` becomes the text **array**, not a length; the expectation is derived
  from it (`const doubled = [...before, ...before]`) so it cannot drift from the
  fixture. This is exactly what a Cmd+A → Cmd+C → Cmd+V produces: `pasteAnchorId`
  (`core/block-ops.ts:640`) anchors after the document-last selection root and
  the selection is not replaced, so the forest is appended whole.
- Replace the poll + re-read with one `awaitDocument` call, `deadlineMs: STALL_MS / 2`,
  and report both milestones:

```ts
const { rowsAt, textAt, last } = await awaitDocument(page, blockTexts, {
  grewBeyond: before.length,
  expected: doubled,
  timeoutMs: STALL_MS / 2,
  startedAt: t0,
});
r.ok(`paste ROWS rendered before the server answered (${rowsAt}ms vs a ${STALL_MS}ms stall)`, rowsAt >= 0);
r.ok(`paste TEXT rendered before the server answered (${textAt}ms vs a ${STALL_MS}ms stall)`, textAt >= 0);
r.eq("the paste really did go through the op pipeline", opRoute.count, 1);
r.eq("the optimistic rows are the doubled document", last, doubled);
```

  The deadline is the bound, so `rowsAt >= 0` alone carries the timing claim —
  no second comparison that could disagree with it. The content assertion now
  covers all 26 rows and reads the *same observation* the wait proved.
- Post-reload: replace `waitFor(visible)` + blind `waitForTimeout(3000)` with
  `awaitDocument(…, { expected: doubled, timeoutMs: 30_000 })`. Same class of
  flaw (blind wait, then assert), currently masked by a generous timeout.
- **Keep the blind wait after `opRoute.release()`.** That one is correct: it
  waits for the confirming push to *arrive* while asserting the document did
  **not** change. A poll-until-equal there would return at t=0 and prove nothing.
  Not every fixed wait is a bug — only a wait for a proxy of the thing asserted.
- Fold the post-push pair (`settled.length === before * 2` plus a 3-row slice)
  into one full-array `r.eq` against `doubled` — strictly stronger, one line.

### 3. Migrate the two sibling scripts (mechanical, no behaviour change)

- `duplicate-verify.ts` — its hand-rolled loop becomes an `awaitDocument` call.
  This is the point of the extraction: the precedent stops being a convention
  three scripts re-implement.
- `drag-reorder-verify.ts` — same call with `grewBeyond` omitted (single
  milestone). Lowest value of the three; drop it if the diff feels noisy.
- Move the byte-identical `blockTexts` closure — currently copied into all three
  scripts — into `support/blank-page.ts` as `blockTexts(page)`, beside
  `editableBlocks` / `blockText`.

## Files

| File | Change |
| --- | --- |
| `plugins/page/plugins/editor/e2e/support/optimistic.ts` | **new** — `awaitDocument`, with the two-milestone rule stated once |
| `plugins/page/plugins/editor/e2e/support/blank-page.ts` | add `blockTexts(page)` |
| `plugins/page/plugins/editor/e2e/paste-optimistic-verify.ts` | the fix (§2) |
| `plugins/page/plugins/editor/e2e/duplicate-verify.ts` | migrate onto the helper |
| `plugins/page/plugins/editor/e2e/drag-reorder-verify.ts` | migrate (optional) |

## Non-goals

- **No change to product code.** The row→text gap is the designed behaviour of
  the local content-doc pre-seed, and the sibling spec already treats it as
  expected-and-acceptable so long as both milestones beat the server. If the runs
  below show `textAt` is large enough to read as a flash of empty blocks, that is
  a separate product finding to raise — not something to fix inside a spec.
- **No generic harness poller.** ~6 hand-rolled deadline loops exist across
  unrelated e2e scripts (`convert-in-place`, `inline-format`, `visible-line`,
  two under `primitives/pane`, one under `apps-core/tabs`). Unifying them is a
  worthwhile follow-up task, not this fix's scope.

## Verification

The worktree is not deployed yet (no socket in `~/.singularity/sockets/`), so:

```bash
./equin build
bun plugins/page/plugins/editor/e2e/paste-optimistic-verify.ts
```

1. **Run it 6 times consecutively** and require 6 green runs — the reported bug is
   2-in-4, so a single pass proves nothing. Record the `rowsAt` / `textAt` numbers
   printed in the two `ok` lines.
2. **Check the headroom.** Both milestones must sit well under the 2000ms
   deadline. If `textAt` is anywhere near it, say so rather than raising the
   deadline — a deadline raised to accommodate the app is the spec quietly
   weakening.
3. **Prove it can still fail.** Temporarily assert against a wrong expectation
   (e.g. `[...before, ...before, "x"]`) and confirm the run goes red with a
   got/want diff rather than hanging or timing out silently.
4. Run the two migrated scripts once each: `duplicate-verify.ts`,
   `drag-reorder-verify.ts`.
5. `./equin check` (the `no-unroute` lint rule and type-check cover the
   e2e barrel).

If the full-document expectation turns out to disagree with a correct paste in
some detail the current 3-row slice never looked at (a trailing empty block
normalised away, say), fix the *expectation* to the observed-correct document and
note why in the script — do not fall back to the narrower assertion.

## Outcome (2026-08-03)

Implemented as planned. The full-document expectation held exactly — a correct
paste produces `before ++ before`, 26 rows (12 lines + a trailing empty, twice).

**7 consecutive green runs**, 9/9 assertions each. Measured milestones:

| run | rows | text | gap |
| --- | --- | --- | --- |
| 1 | 496ms | 636ms | 140ms |
| 2 | 44ms | 124ms | 80ms |
| 3 | 59ms | 59ms | 0ms |
| 4 | 112ms | 112ms | 0ms |
| 5 | 303ms | 334ms | 31ms |
| 6 | 87ms | 158ms | 71ms |
| 7 | 84ms | 136ms | 52ms |

Worst case 636ms against the 2000ms deadline — ~3× headroom, so the deadline was
not tuned to fit the app. The row→text gap is 0-140ms (0 whenever the passive
effect flushed before the first poll landed), well below anything a user would
read as a flash of empty blocks: **no product finding to raise.**

Negative control: a deliberately wrong expectation (`[...before, ...before,
"SENTINEL"]`) failed 4/9 with full got/want diffs and `textAt = -1`, terminating
at the deadline rather than hanging — the spec can still go red.

`duplicate-verify.ts` (27 checks) and `drag-reorder-verify.ts` (25 checks) both
green after migration; `./equin check` exits 0.
