# A blank line is an empty paragraph

## Context

Copying blocks out of a page puts markdown on the clipboard as `text/plain`, and
agents read the same projection through `read_page`. Every empty paragraph in the
page — the spacer between two sections, the blank line before a heading — comes
out as the literal string `<text/>`. A page with normal spacing reads as
boilerplate, both to a human pasting into another app and to an agent reading the
document.

The tag exists for a real reason. `parseMarkdownToForest`
(`plugins/page/plugins/editor/core/markdown.ts:748`) skips blank lines, because in
foreign markdown a blank line is a paragraph separator: pasting a README under any
other rule sprays an empty paragraph between every two paragraphs. So the current
contract is asymmetric on purpose — what we emit round-trips exactly, what a user
pastes stays lenient — and `<text/>` is the one spelling of "empty paragraph" that
no foreign document produces by accident
(`plugins/page/plugins/text/core/text-block.ts:13`, and the design doc that
introduced it, `research/2026-08-03-page-markdown-block-roundtrip.md:258`).

The outcome we want: an empty paragraph is a blank line, everywhere it is read or
pasted, and pasting foreign markdown stays exactly as lenient as it is today.

## The design

Two things change, and they are independent.

**1. A blank line means an empty paragraph — in our dialect only.**

`MarkdownContext` gains a required field naming which dialect the text is in:

```ts
export interface MarkdownContext {
  handles: BlockHandle<unknown>[];
  protectedSpans: ProtectedSpan[];
  /** How a blank line reads: an empty paragraph (our own emission), or nothing
   *  (foreign markdown, where it is a paragraph separator). */
  blankLines: "empty-block" | "separator";
}
```

Required, so a call site that does not state its dialect is a tsc error rather
than one that inherits a default. The serializer ignores the field — there is one
emitted form for everybody.

**2. The rules for where a blank line's block lands.**

- A blank line becomes an empty block of the default-text type, inserted at the
  indentation of the block that **follows** it — which, given how `tokensToTree`
  (`markdown.ts:1023`) pops the stack, is the same as saying it becomes that
  block's **previous sibling**. Two blank lines in a row give two empty blocks,
  both siblings of what follows; no counting rule.
- A blank run with nothing after it — the start or the end of a document or of a
  container tag body — is dropped.
- *(Added 2026-09-25.)* A blank line an AGENT writes beside a tag line is
  spacing: `dropBlankLinesBesideTags` removes it from `edit_page`'s `new_string`
  and `write_agent_note`'s content before parsing. Agents write
  `</human>\n\n<agent-inline>…` as a matter of course, and reading that line as
  an empty paragraph minted a block in the page's prose, so the whole edit was
  refused. The parser itself is unchanged — a spacer already on the page must
  stay one when a card is inserted beside it. The serializer pins an empty
  paragraph beside a tag line as `<text/>`, so a read never holds a blank line
  there and the rule never drops a paragraph an agent copied from a read.

`markdown.ts` still names no block type: the empty block is minted through
`defaultTextHandle(handles)` (`markdown.ts:292`), the same accessor the plain-
paragraph fallback already uses, and a composition shipping no default-text type
simply skips blank lines as it does today.

### Which call site gets which dialect

| call site | direction | blank line |
| --- | --- | --- |
| `markdown-apply/server/internal/read.ts:103` — `read_page` | emit | blank line |
| `markdown-apply/server/internal/apply.ts:186` — `edit_page`, `write_agent_note` | parse | empty paragraph |
| `editor/web/internal/clipboard-write.ts:38` — copy → `text/plain` | emit | blank line |
| `editor/web/components/block-editor.tsx:859,1480` — container paste, drop | parse | skipped |
| `editor/web/components/block-forest-paste-plugin.tsx:75` — caret paste | parse | skipped |

The two server halves both build their context in one place —
`serverMarkdownContext()` (`markdown-apply/server/internal/markdown-context.ts`),
whose whole stated purpose is that no two ends of the round trip run different
dialects — so `"empty-block"` is declared there once and `read_page`, `edit_page`
and `annotations/agent-access`'s append all inherit it. The three web paste sites
build theirs inline and each states `"separator"`.

Internal copy/paste never reaches markdown at all: `writeForestToClipboard` also
writes the structural `BLOCKS_MIME` flavor, and `decideTransfer`
(`editor/web/internal/transfer.ts`) prefers it. Markdown is the projection for
everyone else.

## The accepted loss

A blank line carries no indentation of its own, so this dialect cannot represent
every empty block. Two cases resolve by the rules above rather than faithfully,
and this is a deliberate, understood trade — not a defect to fix later:

1. **An empty block at the start or end of a document or container body** is
   dropped. On an apply that is an ordinary delete (`plan.ts:643`). An empty text
   block owns nothing — no text, no attachments, no links — so losing the row id
   costs nothing beyond the row.

2. **An empty block whose depth differs from the block after it** comes back at
   the following block's depth. On an apply that is a `parentId` update
   (`plan.ts:517`), i.e. a move, and the row id survives.

Case 2 has a consequence worth stating plainly, because it can surface as a
refused apply rather than as a cosmetic difference. Given a page like:

```
- Bullet
  - Nested
  (empty paragraph, last child of Bullet)
Next section.
```

`read_page` emits a blank line for the empty paragraph; the rule puts it back at
`Next section.`'s depth, which is root. That is a real move the agent never made.
`touched.ts:105` lists `parentId` among the judged fields, so if the caller
enforces boundaries — `agent-access` requires every write to land inside an
`<agent-note>` card — the move is judged a write outside the card and **the whole
apply is refused**, on an edit that had nothing to do with that block.

Two things keep this cheap to live with and cheap to reverse:

- The `text` handle **keeps its `tag` declaration**, so `<text/>` still parses.
  Documents written before this change keep working, and an agent that needs an
  empty block the rules cannot place can still write one explicitly.
- Because the tag is still claimed on the parse side, restoring exactness later is
  one ternary in `text-block.ts` (emit `<text/>` instead of `""` when the
  following block sits at a different depth). Nothing else has to move.

A test pins case 2's behavior so it stays a known outcome rather than a
rediscovered surprise.

## Files to change

**The dialect** — `plugins/page/plugins/editor/core/markdown.ts`

- `MarkdownContext` (~line 40): add the required `blankLines` field with the doc
  comment explaining why it exists.
- `parseMarkdownToForest` (line 720): replace the `if (raw.trim() === "")` skip at
  line 748 with a pending-blank counter. Every branch that pushes a token (tag,
  fence, claimer, plain paragraph) first flushes the pending blanks as empty
  default-text tokens **at that token's own indent** — but only when
  `tokens.length > 0`, which is exactly what drops a leading run. Blanks still
  pending when the input ends are discarded, which drops a trailing run. Under
  `blankLines: "separator"` the counter is never flushed, reproducing today's
  behavior byte for byte.
- `indentLines` (line 1054): do not pad an empty line. A nested empty block would
  otherwise emit `"  "` — trailing whitespace that gets stripped in transit and
  reads as noise in a diff. `dedentBlock` (line 841) already ignores blank lines
  when measuring the common indent, so nothing downstream depended on the padding.
- The `BlockMarkdown.tag` doc comment (lines 262-267) cites `page/text` emitting
  `<text/>` as its example of "a `tag` beside a `serialize` is parse-only". The
  pattern is unchanged and `text` still uses it; the example sentence needs
  rewording to say the tag is now the parse-side alias rather than the emitted
  form.

**The block type** — `plugins/page/plugins/text/core/text-block.ts:13-22`

`serialize` returns `""` for an empty paragraph instead of `"<text/>"`. Keep the
`tag` declaration. Rewrite the comment above it: it currently states the opposite
contract ("a blank line cannot represent it").

**Dialect declarations** — one line each

- `markdown-apply/server/internal/markdown-context.ts`: `blankLines: "empty-block"`.
- `editor/web/components/block-editor.tsx:859,1480` and
  `editor/web/components/block-forest-paste-plugin.tsx:75`: `blankLines: "separator"`.

**A stale comment** — `markdown-apply/core/page-title.ts:97` says "a blank line is
inert to `parseMarkdownToForest` anyway", which stops being true. The behavior of
`stripPageTitleBanner` itself is fine: it runs before the parse and consumes the
banner's own blank line, and any leading blanks it leaves behind are dropped by
the leading-run rule.

**The agent's contract** — `annotations/agent-access`, wherever the `edit_page` /
`write_agent_note` tool descriptions are authored: a blank line in a document you
write is an empty paragraph, the same as pressing Enter twice in the editor.

**Docs**

- `plugins/page/plugins/editor/CLAUDE.md:3000-3002` — the bullet in
  *"Markdown is a LOSSLESS PROJECTION of the forest"* states the old contract
  verbatim. Rewrite it to the two rules plus the accepted loss. The section is
  hand-written prose well above the `AUTOGENERATED:BEGIN` marker at line 3058.
- `research/2026-08-03-page-markdown-block-roundtrip.md:258` — add a short
  superseded-by note pointing here; that doc is the rationale for the design being
  replaced.

## Tests

`plugins/page/plugins/editor/core/markdown.test.ts` — four spots:

- the local `text` handle stub (lines 28-40) mirrors the real one; update its
  `serialize`.
- `test("blank lines are skipped on parse")` (388-392) — flip to assert a blank
  line becomes an empty paragraph, and add the `"separator"` case asserting the
  old behavior still holds for pastes.
- `describe("empty paragraphs")` (1259-1269) — both tests assert the current
  spelling and the current asymmetry; rewrite to the new rules.
- the fuzzed round-trip property (1310-1472) already generates empty text blocks
  (line 1341) and is the regression net. It will start failing for the two lossy
  cases, so its generator needs to either avoid producing them or the property
  needs to state the normal form — decide when the failure is in front of you,
  and do not weaken the property beyond those two cases.

New tests, in the same file:

- a blank line lands as the previous sibling of the block that follows, at its
  depth — one case where the following block is shallower, one where it is deeper.
- leading and trailing blank runs are dropped, in a document and inside a
  container tag body.
- `<text/>` still parses, so old documents keep working.

`markdown-apply/core/{plan,touched,page-title}.test.ts` each define their own local
`text` stub (`plan.test.ts:35`, `touched.test.ts:40`, `page-title.test.ts:28`) that
mirrors production; update all three. Add one test to `touched.test.ts` pinning the
case-2 outcome: an empty block at a container's last line, followed by a shallower
block, produces a `parentId` update on a no-op apply.

## Verification

1. `./equin test plugins/page/plugins/editor` and
   `./equin test plugins/page/plugins/markdown-apply`.
2. `./equin check` — no check asserts this contract today
   (`page.editor:markdown-tag-names-unique` is unaffected: `text` still claims the
   name), so this is a regression guard, not a gate to satisfy.
3. `./equin build` in the background, then:
   - **The paste out.** Open a page with spacers between sections, select the
     blocks, copy, paste into a plain-text editor. Blank lines, no `<text/>`.
   - **The paste in.** Copy a README chunk with blank lines between paragraphs and
     paste it into a page. The paragraph count must be unchanged — no empty blocks
     appear. This is the regression the whole dialect field exists to prevent.
   - **The agent round trip.** `read_page` a page containing spacers and confirm
     the output reads as ordinary prose. Then `edit_page` inside an `<agent-note>`
     card on that page and confirm it applies, and that `query_db` shows the
     page's other rows unchanged (`select id, type, parent_id from page_blocks
     where page_id = '<id>' order by rank`) — same row ids, same parents.
   - **The known loss.** Build the case-2 page (empty paragraph as a bullet's last
     child, root block after it), run an unrelated `edit_page`, and confirm the
     outcome matches what this plan says: the empty paragraph moves to root, and
     under boundary enforcement the apply is refused. Confirming it behaves as
     designed is the point; it is not a bug to fix in this change.

## Addendum, 2026-09-03: the accepted loss is closed

The trade above ("a deliberate, understood trade — not a defect to fix later")
was wrong about its cost, and it is now closed. Design and measurements:
[`research/2026-09-03-page-edit-judged-on-what-it-changed.md`](2026-09-03-page-edit-judged-on-what-it-changed.md).

What that trade did not anticipate: cases 1 and 2 do not surface as a cosmetic
difference on the block they concern — they make the whole PAGE unwritable by any
agent, for any edit. `edit_page` re-applies the entire scope document, so every
lossy round trip anywhere on the page arrives at the boundary check as a write
outside every card. A real refused edit measured 12 such violations, none of them
a content write; the agent that hit it spent five attempts and gave up, and the
refusal names one block while counting the rest, so it could not see what to fix.
"An agent that needs an empty block the rules cannot place can still write one
explicitly" was therefore not a workaround — the agent had to hand-place a tag
for every such block on the page, none of which it had touched.

Two changes, and both were needed:

1. **The pin** — the reversal this doc predicted, taken at the SERIALIZER rather
   than in `text-block.ts`: where a blank line cannot state an empty node's
   position (it has children, or it is first or last of its siblings), the
   agent-facing dialect emits the handle's tag form instead. `MarkdownContext`
   gained a second dialect field, `emptyBlocks`, beside `blankLines`. A human
   copying blocks out still gets blank lines and no tags.
2. **The subtraction** — `edit_page` now hands the apply the document the edit
   was made against, and every write that document would ALSO produce is dropped
   before the plan is judged. This absorbs what no projection can represent (a
   paragraph whose text is a single space re-parses as empty), which the pin
   alone cannot fix.

The rules in *The design* above are unchanged: a blank line still means an empty
paragraph on the parse side, and foreign markdown is still exactly as lenient. It
is only the EMISSION that gained an exception, and only for the agent dialect.
