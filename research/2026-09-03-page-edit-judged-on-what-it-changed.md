# An agent's page edit is judged on what it changed

## Context

`edit_page` refuses edits nobody made. On 2026-09-02, `conv-1788356732-p7jw` spent
five attempts and ~4 minutes trying to append one `<agent-note>` card to a page,
was refused every time, gave up, and reported its findings in chat. The note was
never written.

Every refusal named a block the agent had not touched:

> block `block-8b56d608…` was rewritten or moved outside every "agent-note" card
> … (8 other writes in this edit landed outside a card too.)

`edit_page` re-applies the WHOLE scope document on every call, so every block on
the page round-trips through markdown → forest. Two things in that projection are
lossy, and each loss arrives at the boundary check as a write to the page's own
prose:

1. **An empty paragraph is a bare blank line**, and a blank line carries no
   indentation. It comes back at the depth of whatever follows, so one sitting at
   a different depth MOVES (a judged `parentId` write), and one at the start or
   end of a document or tag body is DROPPED. Designed behaviour, recorded in
   `research/2026-09-01-page-blank-line-empty-paragraph.md` as an accepted loss —
   what that doc did not anticipate is that it makes a whole page unwritable by
   any agent, for any edit.
2. **A paragraph whose text is only whitespace** (`" "`) is a blank line to the
   tokenizer, so it re-parses as empty — a text edit on prose. No dialect change
   can spell it: the tag means *empty*.

The agent could not have won. It diagnosed cause 1 correctly on its second attempt
and pinned the block the message named — but the refusal names ONE block and
counts the rest, and there were eight more it could not see.

**Measured, by replaying that exact edit through the real engine** (real handles,
main's 498 rows, the transcript's own `old_string`/`new_string`):

| | violations |
|---|---|
| today | 12 |
| noise subtraction alone | 7 |
| pin alone | 1 |
| **pin + subtraction** | **0** — 72 creates, nothing else touched |

Both halves are needed, and they fix different things. The pin stops the edit
RELOCATING untouched blocks (subtraction cannot cancel those: inserting a card
changes where neighbouring blank lines land, so the writes are not identical to
the identity round trip's). The subtraction absorbs what no projection can
represent — the whitespace-only paragraph.

Neither touches user content. The space stays a space; the blank line stays where
the author put it.

## Design

### 1. Pin an empty paragraph the dialect cannot place

In `serializeForestToMarkdown`'s inner `renderList`
(`plugins/page/plugins/editor/core/markdown.ts:1240`), in the flat-lines branch:
when the serialized line is whitespace-only and the node's position cannot be
stated by a blank line, emit the handle's tag form instead of the blank line.

```
line.trim() === ""  &&  (n.children.length > 0 || first || last of its sibling list)
```

The three positions mirror the parser's own rules: a blank line lands at the
following block's depth (so a node with children, or the last of its siblings,
lands wrong), and a leading or trailing blank run is dropped (so first and last
also vanish at a document or tag-body edge).

Two things this must NOT do:

- **It replaces only the LINE.** Do not route through the tag branch: a
  `body: "none"` tag self-closes and CONSUMES `n.children`. The walk keeps
  emitting children below the pinned line, exactly as for any other flat line.
  (No existing test covers an empty node WITH children — the fuzzer never
  generates one. Add that case, both directions.)
- **It never invents a spelling.** A handle whose `tagFor()` resolves to `null`
  keeps the blank line and keeps the loss.

`page/text`'s tag must emit no attributes, or the pin writes
`<text data="{&quot;text&quot;:[]}"/>`: add `attrs: () => ({})` to its tag
declaration (`plugins/page/plugins/text/core/text-block.ts:31`). The derived
projection JSON-encodes every non-string field into `data=` — see
`markdown.ts:379-401`. `parseAttrs` already ignores whatever it is handed, so a
bare `<text/>` still parses.

**The pin is agent-facing only.** `MarkdownContext` gains a second required
dialect field beside `blankLines`, in its shape and for its reason — a call site
that does not state its dialect is a tsc error:

```ts
/** How an empty block is EMITTED when a blank line cannot state its position. */
emptyBlocks: "pinned" | "blank-line";
```

| call site | value | why |
|---|---|---|
| `markdown-apply/server/internal/markdown-context.ts` (`read_page`, `edit_page`) | `"pinned"` | the round trip must be exact |
| `markdown-apply/core/plan.ts` (the planner's own re-serialization) | `"pinned"` | must match the document the read produced, or alignment diffs two dialects |
| `editor/web/internal/clipboard-write.ts` | `"blank-line"` | a human pasting into another app never sees a tag; internal paste uses the structural clipboard flavour, so nothing is lost where it matters |
| the three web paste sites | `"blank-line"` | parse-side; states the field because the record is one dialect |

### 2. Subtract the round-trip noise

`ApplyBlockOptions` (`markdown-apply/server/internal/apply.ts:92`) gains:

```ts
/** The document the caller's edit was made against — what the read returned
 *  before the caller spliced it. Writes this document would ALSO produce are
 *  round-trip loss, not the caller's edit, and are dropped before judgement. */
baseline?: string;
```

`applyMarkdownToBlock` plans the baseline against the SAME rows, then subtracts
from the real plan every write that appears identically in both, and judges and
applies the remainder. The subtraction itself is a pure function in
`markdown-apply/core` (new `subtract-noise.ts`, exported from the core barrel) so
it is unit-testable without a database.

What can be compared, and what cannot:

- `updates`, `deleteIds`, `textEdits` — safe. They key off EXISTING row ids, and
  `planMarkdownApply` is otherwise deterministic (`Rank.nBetween` is
  deterministic; no randomness in `plan.ts` or `align.ts`).
- `creates` — **deliberately not subtracted.** Each pass mints fresh
  `crypto.randomUUID()` ids and a fresh `new Date()` (`plan.ts:336`, `plan.ts:569`),
  so two passes are not comparable. A create in the noise plan would mean the read
  invented a block; with the pin, none is observed. If one ever appears it lands
  outside a card and is refused loudly — which is the right failure.

The hook order stays as it is: subtract, then `assertAcceptable(plan, rows)`, then
write. The policy must judge what will actually be written.

`ApplyReport` is recomputed off the subtracted plan — `stats`, `createdIds`,
`survivingIds`, `textEditedIds` are all surfaced verbatim to the agent by
`applySummary` — plus one new count of writes the round trip absorbed, so the
subtraction is visible rather than silent.

Only `edit_page` passes `baseline` (`mcp-tools.ts:358` reads it,
`mcp-tools.ts:409` applies). `write_agent_note` builds its document from scratch
and holds no baseline; it needs none, since its apply is rooted at one card.

### 3. The invariant, as a test

**Reading a page out and applying it straight back must plan zero writes.**
Nothing asserts this today, which is why the loss was found by an agent burning
five attempts rather than by a failing test.

- Strengthen the existing property test (`markdown.test.ts:1568`): `representable()`
  currently filters out every empty node that is first or last of its siblings —
  precisely the cases the pin fixes. Drop that filter and let the property assert
  the exact round trip. Add empty-nodes-with-children to the fuzzer's generator.
- Flip `touched.test.ts:283` (`describe("an empty paragraph the blank-line dialect
  cannot place")`): the read now emits `<text/>`, the identity apply plans nothing,
  and `violationsOf(...)` becomes `toEqual([])`. Keep it as the regression pin,
  renamed to what it now proves.
- New unit tests for `subtractNoise`: identical write dropped, differing write on
  the same block kept, creates never dropped.

## Files

**Pin** — `editor/core/markdown.ts` (the branch + the `MarkdownContext` field),
`text/core/text-block.ts` (`attrs`), the five context call sites in the table
above, and the four test files carrying local mirror declarations of the `text`
handle (`markdown.test.ts`, `plan.test.ts`, `page-title.test.ts`,
`touched.test.ts`) which need the same `attrs: () => ({})` to match real output.

**Subtraction** — `markdown-apply/core/subtract-noise.ts` (new) + core barrel,
`markdown-apply/server/internal/apply.ts`, `agent-access/server/internal/mcp-tools.ts`.

**Docs** — `editor/CLAUDE.md`'s "Two empty blocks do NOT round-trip, knowingly"
paragraph (now false); the `read_page` tool description
(`mcp-tools.ts:126-136`), which currently tells agents to hand-place `<text/>`
themselves; and an addendum to `research/2026-09-01-page-blank-line-empty-paragraph.md`
recording that its accepted loss is closed and why.

## Verification

1. `./equin build`, then `./equin test plugins/page`.
2. The real repro, end to end: `read_page` on
   `block-f0d24b10-d743-409d-bbc1-844ed27db026` (the page that refused every edit),
   then `edit_page` appending a tagless `<agent-note>` card at page level. It must
   apply, reporting creates only — 0 updated, 0 deleted, 0 text-edited.
3. Confirm the read now shows `<text/>` at the four positions a blank line cannot
   state, and bare blank lines everywhere else.
4. Confirm a copy out of the editor still pastes with blank lines, no tags.

## Addendum, 2026-09-10: the assumption about noise creates was false

> A create in the noise plan would mean the read invented a block; **with the pin,
> none is observed**. If one ever appears it lands outside a card and is refused
> loudly — which is the right failure.

Both halves of that were wrong, and the second is what cost a conversation its
whole run.

**A create is observed.** One block holding a **soft line break** — a `\n` inside
a run, which is what Shift+Enter stores and what pasting multi-paragraph HTML
leaves behind — has no markdown spelling. The serializer emits the newline
verbatim and the block walker fans that one block out into several document lines
at the block's own indent, indistinguishable from several sibling blocks. Reading
such a page out and applying it back completely unchanged plans creates. Six pages
on main were un-editable by any agent this way.

**"Refused loudly" meant refused loudly AT THE AGENT, for the engine's fault.** A
phantom create lands wherever the lossy block sits, so on `conv-1788965027-vvze`
(2026-09-09) it landed inside a `<todo>` card at the top of the page. Every
attempt to append one `<agent-note>` card elsewhere was refused naming that card —
a card the agent had never gone near, in a message that told it to leave the
author's words alone. It tried four times with three different anchors, stopped,
and reported that it did not understand the failure. The user pasted its report
into the page by hand.

The projection loss is fixed at its source (the soft break gains an inline `\n`
escape, so the block stays on one line), and — the part that matters here — **the
assumption is now enforced rather than assumed.** `applyToScope` refuses with a
409 when the baseline's identity plan contains creates at all, naming the scope,
the page, the count, and the rows whose stored text the round trip would rewrite.
So the next unspellable thing surfaces as *this page's markdown projection is
lossy* rather than as an accusation against whichever agent touches the page next.
Creates only: the other three channels key off existing row ids and are absorbed
by design, and making them fatal would refuse edits that work today.

Design and measurements:
[`research/2026-09-10-page-soft-break-markdown-round-trip.md`](2026-09-10-page-soft-break-markdown-round-trip.md).
