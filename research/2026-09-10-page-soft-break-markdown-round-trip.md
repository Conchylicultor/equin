# A soft line break survives the markdown round trip

*2026-09-10 — page/editor, page/markdown-apply*

## Context

`edit_page` refuses edits nobody made. Again.

On 2026-09-09, `conv-1788965027-vvze` tried four times to append one `<agent-note>`
card to the *Plugin system* page, was refused identically every time, stopped, and
reported that it did not understand the failure. The card was never written; the
user pasted the agent's report into the page by hand.

Every refusal named a `<todo>` card at the top of the page that the agent had never
gone near:

> block `block-9eb2a417…` was created, and it sits inside `<todo>` card
> `block-ee4598f3…`. (1 other write in this edit was refused too.)

This is the same shape as `conv-1788356732-p7jw` on 2026-09-02, whose fix is
`research/2026-09-03-page-edit-judged-on-what-it-changed.md`. That design stated the
right invariant — *reading a page out and applying it straight back must plan zero
writes* — and built two mechanisms for it. Both work. Neither covers this input,
and the reason they don't is written down in that doc as an assumption:

> **`creates` are never subtracted, and cannot be.** … A create in the noise plan
> would mean the read invented a block, which is a bug in the projection rather
> than something to absorb. … If one ever appears it lands outside whatever
> boundary the caller judges by and is refused loudly, which is the correct
> failure.

A create does appear, the read does invent blocks, and "refused loudly" turned out
to mean *refused loudly at the agent, for the engine's fault* — which is what cost
this conversation its four attempts.

**Measured, by replaying the real page's rows through the real engine.** Reading
`block-6b4d4ded` (*Plugin system*) out and applying it back **completely unchanged**
plans:

```
create text  parent=<todo block-ee4598f3>  "Goal: Allow to inject prompts and mental models…"
create text  parent=<todo block-ee4598f3>  ""
textEdit block-f07d2ad0     (its stored text cut down to its last line)
textEdit block-5369ed0d
```

`subtractNoise` cancels both text edits. The two creates cannot be cancelled, so
they are judged as the agent's own writes, land inside the author's `<todo>` card,
and refuse the whole edit. Four attempts, three different anchors, one placeholder
one-liner — all refused identically, because none of it was ever about the anchor.

Six pages on main are un-editable by an agent this way today: *Todos*, *Website*,
*Why singularity*, *Story*, and two called *Plugin system*.

## What is actually happening

One block holds a **soft line break**. In the database:

```
block-f07d2ad0  data.text = [{ text: "Goal: Allow to inject prompts…guidance,...\n\nRisk: Plugin tree should be…?" }]
```

That is one block, not three. A `\n` inside a run is first-class content, and every
layer but markdown agrees:

- `TextRun.text` says so in its own type (`editor/core/rich-text.ts:71-74`: *"May
  contain `"\n"` soft breaks"*).
- `walkNode` mints a run `{text:"\n"}` for a Lexical `LineBreakNode`, and
  `appendRun` splits on `\n` to rebuild one (`editor/core/runs-lexical.ts:121-160`,
  `:241-263`). Shift+Enter round-trips.
- The Yjs doc — the authoritative store — keeps the break as its **own node**, not
  as a character (`editor/core/runs-yjs.ts:74-90`). `data.text`'s `\n` is the
  projection of that node.
- `read-only-view`'s `RunsRenderer` renders it as `<br>`
  (`read-only-view/web/components/runs-renderer.tsx:92-102`).
- Page history treats adding or removing one as a content change
  (`apps/pages/plugins/history/web/internal/build-diff.ts:44-54`).

It arrives by Shift+Enter, or — as here — by pasting multi-paragraph HTML with a
single-line `text/plain` beside it, which is ordinary output from Notion, Google
Docs and the like. `$flattenToInline` unwraps the paragraphs and emits a
`LineBreakNode` at each boundary; `editor/CLAUDE.md:1969` documents exactly this,
including the trailing `\n` a `<p>a</p><p></p>` leaves behind (which is the second
lossy row on this page, `block-5369ed0d`).

**Markdown is the one layer with no spelling for it.** `escapeText` emits the `\n`
verbatim (`editor/core/inline-markdown.ts:411-425`; `ESCAPABLE` at `:332` has no
`\n`), so `ctx.md(runs)` returns a string with a real newline in it. The block
walker then does `out.push(...line.split("\n"))`
(`editor/core/markdown.ts:1291`), which fans that one block into several document
lines **at the block's own indent** — indistinguishable from several sibling
blocks. `parseMarkdownToForest` splits the document on `\n` up front (`:782`) and
reads them back as exactly that; under `blankLines: "empty-block"` a `\n\n` also
mints an empty paragraph between the halves.

So the smallest failing page is two blocks:

```
block A   text: "Notes"
block B   text: "Goal: x\n\nRisk: y"
```

`read_page` prints four lines, and handing them back unchanged plans two creates
and one text edit:

| line | planned |
| --- | --- |
| `Notes` | matches block A — no write |
| `Goal: x` | **create** |
| *(blank)* | **create** |
| `Risk: y` | matches block B, text cut down to this line |

The contract this breaks is stated in `editor/CLAUDE.md:3070-3075` — *"CANONICAL on
serialize: anything this codebase emits re-parses to the same forest — with one
named exception"*. A soft break is a second, unnamed exception.

## Design

### 1. A soft break has a spelling: the inline escape `\n`

A soft break becomes the two characters backslash + `n`, so **the block stays on one
markdown line**. Nothing about the document's line, indent or blank-line rules is
touched, and the ambiguity disappears at its source rather than being decoded
downstream.

The alternative — a real newline plus some continuation marker — is worse than it
looks. The inline scanner refuses to let a construct span a real newline
(`matchDelimiter` at `inline-markdown.ts:821`, `matchLink` at `:750` and `:768`), so
a genuine newline reaching the scan would break bold, italic or a link that spans a
soft break. An escape never reaches the scan as a newline, so those guards keep
meaning what they say.

**This defence already exists one layer up, for the same reason.** A page's title
collapses `\r?\n` to a space before serializing (`markdown-apply/core/page-title.ts:52`),
and the comment above it states this exact failure: *"A title carrying a `\n` would
otherwise emit a second line the document never accounted for — which the parser
would read as a paragraph and the planner as a created block, from a page's title
alone."* The title was defended; block text was not.

#### The escaping rule gains one transforming escape

`inline-markdown.ts` states its rule once and both directions implement it
(`:246-263`). Today it is a set of characters that escape to themselves:

```ts
const ESCAPABLE = new Set(["\\", "*", "_", "~", "`", "[", "]", "<"]);
```

It becomes a table, because a soft break is the first escape whose decoded form
differs from the character after the backslash:

- **encode** — the character to emit it as: identity for the existing eight (`*` →
  `\*`), plus `"\n"` → `\n` (backslash, letter `n`).
- **decode** — what a backslash + that character yields: identity for the existing
  eight, plus `n` → a newline.

One table (`ESCAPES`), both maps derived from it, so an escape this module emits and
one it reads back cannot come from two lists.

The DIALECT gets a name of its own — `SoftBreaks`, exported from
`inline-markdown.ts`, where the escape lives — so `MarkdownContext`,
`serializeInlineMarkdown`, `emitRuns` and `escapeText` reference one definition
instead of respelling the union five times. That means the core barrel gains an
export and the generated plugin docs move with it.

The change is small but not four lines: the dialect threads through
`serializeInlineMarkdown`'s signature into `emitRuns` — both its leaf call and its
recursive one — and into `escapeText` (`:411-425`), which looks the character up in
the encode table instead of testing set membership. `isEscapeAt` (`:634-640`) tests the decode
table's keys. Of its four call sites, three only skip two characters and are
untouched; the one that actually emits (`scanSpan`, `:887-890`, `buf += s.text[i+1]!`)
reads the decode table. The rule in the header comment gains one clause.

**Backwards compatible, because the encoder escapes the backslash first.** A run
holding the two literal characters backslash + `n` is unaffected and cannot be
confused with a soft break. This holds in BOTH dialects — `"newline"` drops only the
break's row from the table, so the backslash is still escaped there — which is what
lets the parse side stay unconditional with no caveat:

| run text | emitted | parsed back |
| --- | --- | --- |
| `a`, soft break, `b` | `a\nb` | `a`, soft break, `b` |
| `a`, `\`, `n`, `b` | `a\\nb` | `a`, `\`, `n`, `b` |

On the way in the decode is **unconditional**, in every dialect — the established
asymmetry (*lenient on parse, canonical on serialize*). An agent that hand-writes
`\n` gets a soft break, which is what it meant.

**A soft break at the edge of a marked run is hoisted out of the mark, and that is
pre-existing.** `hoistBoundaryWhitespace` (`:469-496`) trims with `trimStart` /
`trimEnd`, which treat `\n` as whitespace, so a bold run whose text ends in a soft
break canonicalizes to a bold run plus a bare one. The round trip has always been
`parse(serialize(x)) === canonical(x)` rather than `=== x` (stated at `:283-287`),
and this is one more case of it. It matters only in that it lands as a **text edit**,
which `subtractNoise` absorbs — never a create — so it cannot refuse an edit. An
interior soft break inside a marked run is untouched by the hoist and round-trips
exactly: the escaped form carries no real newline, so `matchDelimiter`'s newline
guard (`:821`) never fires and its closing delimiter is still found.

#### The dialect: `softBreaks`

`MarkdownContext` gains a third required field beside `blankLines` and
`emptyBlocks`, with the same shape and the same reasoning — only the caller knows
whether the document it is about to produce will be read back by this codebase or by
a person in another app, so there is no safe default and a call site that does not
say is a tsc error.

```ts
/**
 * How a soft line break inside a block's text is EMITTED.
 *
 * `"escaped"` — the two characters `\n`, keeping the block on one line, so the
 * round trip is exact. `"newline"` — a real newline, which a person pasting into
 * another app must see, and which this codebase then cannot read back as one
 * block. Read on SERIALIZE only: the parse side decodes the escape always.
 */
softBreaks: "escaped" | "newline";
```

`serializeInlineMarkdown` takes it as a third argument. There are exactly two
non-test call sites — the `md` accessor bound in `serializeForestToMarkdown`
(`markdown.ts:1232-1233`) and the page-title banner (`page-title.ts:54`) — and both
already hold the context.

| call site | value |
| --- | --- |
| `markdown-apply/server/internal/markdown-context.ts` (`read_page`, `edit_page`) | `"escaped"` |
| `markdown-apply/core/plan.ts` (the planner's own re-serialization) | `"escaped"` — must match what the read emitted, or alignment diffs two dialects |
| `editor/web/internal/clipboard-write.ts` | `"newline"` |
| `editor/web/components/block-editor.tsx` ×2, `block-forest-paste-plugin.tsx` | `"newline"` — parse-side, unread, stated because the record is one dialect |

#### One rule, no per-path exception

The escape belongs in `escapeText`, so every path that renders run text inherits it.
That includes the tag-`body: "text"` branch (`markdown.ts:1302-1313`), which today is
the *only* place a soft break survives — it emits a multi-line body between the tags
and rejoins it on parse. `page/prompt` is the single block type using it
(`prompt/plugins/block/core/prompt-block.ts:26`); `quote` moved off it.

In the escaped dialect a prompt's body becomes `<prompt>a\nb</prompt>` on one line
instead of a two-line body. It still round-trips (parse joins the body's lines, then
decodes), and the multi-line branch stays live for the clipboard dialect. This is
deliberate: one spelling for a soft break everywhere in the agent-facing document
beats a spelling with an exception nobody will remember, and it costs one test's
expectation.

The alternative is to keep the readable two-line body by escaping only when a mark
or link wrapper is open. It buys prettier prompt bodies at the price of two
spellings for one thing, chosen by a condition an agent editing the body cannot
see — and, as the next section shows, the unescaped body is exactly where marks
across a break are silently lost today. Not worth it.

**`markdown.ts:1291`'s `line.split("\n")` stays, and is load-bearing.**
`code-block` has an explicit `markdown.serialize` returning a genuinely multi-line
string (`code-block/core/code-block.ts:27`: `` "```" + lang + "\n" + code + "\n```" ``),
and it takes the flat-lines branch because a declared `serialize` wins over the
derived tag (`markdown.ts:582`). Its parse side is the `fence`, which is parse-only,
so that string is the only way a code block reaches the document. This is also why
the encode must NOT be a post-pass on `line` in `renderList`: at that point the
string is opaque — prefix, fence and inline text already concatenated — so escaping
there would collapse every fenced block onto one line and turn the code's own
newlines into literal `\n`. The escape belongs where run text is rendered and
nowhere else. Every other explicit serializer is single-line (`numbered-list`,
`to-do`, `text`, `divider`, `equation`), so after this change a fan-out on that line
can only come from a handle that deliberately produced one.

#### The assert that makes that provable

`serializeInlineMarkdown` in the escaped dialect promises **one line**, so it should
say so at runtime: if its result contains a raw newline, throw. Search for the
culprit run by its `text` **or** its `link`, and report the run either way: in the
href case the newline is in `link` and that run's own text is usually newline-free,
so a search over `text` alone would name the wrong run or none — and the href case is
the likelier of the two. That is fix-ladder
rung 4 for the two leaks no type can see — a `link` href holding a newline
(`escapeUrl` at `:406-409` escapes only `\` and `)`, and `matchLink` would then fail
to read it back), and a future `protectedSpans` pattern that matches across a break.
Both are silent corruption today and a named crash after.

None of the three registered protected-span patterns can straddle a newline
(`math/plugins/inline/core/tokens.ts:9`, `inline-page-link/core/tokens.ts:20-21`,
`inline-date/core/tokens.ts:13-22` all exclude it), but nothing states that they must
not. The `MarkdownSpan` doc (`inline-markdown.ts:311-329`) gains the constraint: a
`"protect"` family's pattern must not match across a line break, because its bytes
are emitted verbatim and a token straddling a break has no one-line spelling.

#### Three live bugs this fixes on the way past

Each is the same class — the projection loses something — and each is currently
silent:

- **A mark across a soft break is dropped.** `parseInlineMarkdown("**a⏎b**")` returns
  one unmarked literal run, because `matchDelimiter` bails at a real newline
  (`:815`). Reachable today through the one path that emits real newlines between
  tags, the `prompt` body — so a bold prompt line does not survive `read_page` →
  `edit_page`, and lands as an update on a card the agent never touched.
- **A link across a soft break is dropped**, identically, via `matchLink`
  (`:750`, `:768`).
- **A block whose text is only a soft break is deleted outright.** `text`'s
  serializer renders it as `"\n"`, and the empty-block pin tests
  `line.trim() === ""` (`markdown.ts:1281`) — true for a lone newline — so the block
  is emitted as `<text/>` and comes back with `text: []`. With the escape the line
  is two non-blank characters, the pin correctly declines, and the block survives.

All three fall out of "no real newline ever reaches the scan", which is the same
property that fixes the reported bug. That is the argument for one rule rather than
a conditional one.

#### The accepted cost, stated

Decoding is unconditional, so a lone `\n` in **foreign pasted** markdown now means a
soft break where it used to mean the two literal characters. `C:\new` gains a line
break; so does `` `printf "a\n"` ``, since `scanSpan` resolves escapes inside a code
span too (`:886-890`). This is the same leniency cost the module already accepts and
pins for `\*` inside a code span (`inline-markdown.test.ts:474-477`), and it is
unavoidable given the escape: our own emitted document has to round-trip. The rule
comment says so, and a test pins `C:\new` as the honest example.

### 2. The backstop: the identity round trip may not CREATE

Fix 1 closes the loss we know about. This closes the class, and it is the half that
was missing this time: nothing anywhere asserts that the document `read_page` hands
out is a faithful picture of the page, so the next unspellable thing will again
surface as an accusation against whichever agent touches the page next.

`applyToScope` already plans the baseline and already has a guard on exactly this
line, with exactly the right sentence
(`markdown-apply/server/internal/apply.ts:285-294`):

```ts
const identity = planOf(baseline);
if (!identity.ok) {
  // The document a read produced cannot be applied back onto the rows it was
  // read from. Nothing the caller did can cause this, so it is a bug in the
  // read or the planner, and it must be loud rather than degrade into an
  // unsubtracted apply that then refuses the caller for the engine's fault.
  throw new Error(…);
}
```

It tests the wrong condition. A planner that *refuses* the baseline is caught; a
planner that *succeeds while inventing blocks* is not, and that is the reachable
case. Add the second condition beside it:

```ts
if (identity.plan.patch.creates.length > 0) throw new HttpError(409, …);
```

**Creates, and only creates.** The other three channels are keyed by existing row
ids, so `subtractNoise` cancels them and the row survives untouched — that is the
designed, working behaviour (a paragraph whose text is a single space is absorbed
exactly this way, and refusing it would break edits that work today). A create has
no id to key on: each planning pass mints a fresh `crypto.randomUUID()`, so the two
passes' creates are not comparable and there is nothing to subtract. That is the
one channel where round-trip damage cannot be told apart from the caller's work,
which is precisely why it must stop the apply instead of being judged.

**Not "drop the phantom creates".** With no id to match on, the only handles are
content and position, and an edit near the lossy block changes both — so the match
is guesswork, and a wrong one either deletes the author's text or silently lets a
phantom block through. It would also hide the projection bug permanently: every
edit would appear to succeed while the page's markdown stayed a lie, and the block
would keep re-splitting differently on each pass.

**`HttpError(409)`, not the neighbour's plain `Error`.** The neighbouring guard is
genuinely unreachable, so a 500 is fine for it. This one is reachable from ordinary
user data, and the agent that hits it is the only party who can relay it — it has
to be able to read the message. 409 matches the planner's own refusal a few lines
up (`apply.ts:268-274`) and `chainToPageRoot`'s corrupt-forest refusal
(`agent-access/server/internal/policy.ts:197-237`): *this cannot be applied*, not
*you did something wrong*.

**The message names the page, the count, and the candidate rows.** The rows whose
stored text the identity plan would rewrite (`identity.plan.textEdits`) are a
superset containing the lossy one — deliberately a superset, since narrowing it
further would mean guessing. Each is worth a short preview of its stored text so
the user can find it in the page. Following the `agent-access` idiom (name the ids,
state the rule in one clause, say what to do next):

```
edit_page: this page cannot be edited right now. Reading block-6b4d4ded… out and
applying it back unchanged would itself create 2 blocks, so there is no way to tell
your edit apart from the round trip's own damage. The row whose stored text the
round trip would rewrite is block-f07d2ad0… ("Goal: Allow to inject prompts and
mental models…"). This is a bug in the page's markdown projection, not in your
edit — report it rather than working around it.
```

**What this does not cover, stated rather than discovered.** `write_agent_note`
passes no baseline (`agent-access/server/internal/mcp-tools.ts:257-264`), because it
composes its document from scratch and has no round trip to subtract — so it has no
identity plan and gets no backstop. Its root is one `<agent-note>` card whose
contents it replaces wholesale, and creates inside that card are legal, so a
projection loss there would be written rather than refused. After fix 1 there is no
known loss for it to hit. If one is ever found, the answer is the same guard over a
baseline read of the card, not a second mechanism.

## Files to change

**The spelling** — `plugins/page/plugins/editor/core/inline-markdown.ts`

- `ESCAPABLE` (`:332`) → an encode table and a decode table; `escapeText` (`:411-425`),
  `isEscapeAt` (`:634-640`) and `scanSpan`'s emitting branch (`:887-890`) read them.
- `serializeInlineMarkdown` (`:599-607`) takes the dialect and threads it to
  `escapeText` through `emitRuns`, and asserts no raw newline survives in the escaped
  dialect. Prefer a small `escapedCharAt(s, i)` helper next to `isEscapeAt`, so
  *"does an escape start here"* and *"what does it produce"* stay in one place and the
  non-null assertion has an owner.
- The rule comment (`:246-263`) gains the transforming-escape clause, the accepted
  leniency cost, and a cross-reference to the newline guards at `:750`, `:768` and
  `:815` — which stay exactly as they are, since they are the reason the escape
  exists.
- `escapeUrl` (`:406-409`) is untouched: a newline in an href is unreadable either
  way, and the assert now makes that loud instead of silent.
- The `MarkdownSpan` doc (`:311-329`) gains the no-newline constraint on a
  `"protect"` pattern.

**The dialect** — `plugins/page/plugins/editor/core/markdown.ts`

- `MarkdownContext` (`:48-81`) gains `softBreaks`, documented like its two
  neighbours.
- The `md` accessor (`:1232-1233`) passes `ctx.softBreaks`.

**Dialect declarations** — one line each, at the six sites in the table above.
`markdown-apply/core/page-title.ts:54` passes `ctx.softBreaks` through and changes no
behaviour: the banner already collapses newlines to a space at `:52` and must stay
byte-comparable for `stripPageTitleBanner`, so the one-line guarantee is now belt and
braces rather than the only guard. Worth a sentence in its comment.

**The backstop** — `plugins/page/plugins/markdown-apply/server/internal/apply.ts`

- The guard at `:285-294` gains the creates condition and the message. It needs
  `rows` for the text previews, which `applyToScope` already holds.

**Docs**

- `editor/CLAUDE.md:3070-3095` — the *"Markdown is a LOSSLESS PROJECTION"* contract
  keeps its single named exception (the whitespace-only paragraph) and gains a
  bullet for the soft-break spelling and its dialect.
- The `read_page` / `edit_page` tool descriptions in
  `annotations/agent-access/server/internal/mcp-tools.ts` — one sentence: `\n` in a
  line is a soft line break inside that block, the same as Shift+Enter in the
  editor, and handing it back unchanged is not a write.
- An addendum to `research/2026-09-03-page-edit-judged-on-what-it-changed.md`, in the
  style of the one already on `2026-09-01-page-blank-line-empty-paragraph.md`:
  its "with the pin, none is observed" assumption about noise creates was false,
  what it cost, and that the assumption is now enforced rather than assumed.

## Tests

**The property test is the fix's real net, and widening it is the structural half.**
The loss existed because the fuzzer's alphabet has no `\n` in it — the invariant was
already written down and already executable, it just never saw this input.

- `editor/core/markdown.test.ts:1524-1694`, the fuzzed round-trip property — this is
  the case `editor/CLAUDE.md:3083` means by *"extend it for a new block type rather
  than adding a one-off case"*. Its word list (`:1540-1547`) is chosen so no
  generated line can be claimed by a prefix parser; the comment gains one more
  constraint, that a break may not sit at a word's start or end (the hoist above).
  - add **one word with an interior break** to the list, e.g. `"golf\nhotel"`.
    Because `pick` (`:1650-1662`) joins words with spaces and marks them about 55%
    of the time (two independent draws: 25% bold, then 40% of the rest italic), that
    single word covers a break inside a marked run, inside an unmarked one, in every
    text-bearing type, and in the `prompt` tag body.
  - add three `gens` entries for canonical shapes the word list cannot reach: a run
    that is only a break (which also pins that the empty-block pin declines it), a
    trailing break (`block-5369ed0d`'s shape, unmarked so no hoist), and the
    three-run `[bold "a"][break][bold "b"]` shape `walkNode` actually produces.
  - do **not** put a bare `"\n"` in the word list: `pick` could make it the only word
    and then mark it, which the hoist legitimately rewrites — failing an assertion
    that is not about this feature.
  - the idempotence half (`:1690-1693`) is what catches a serializer emitting a form
    it cannot re-emit.
- `editor/core/markdown.test.ts`, flat-lines cases: an interior break, a trailing
  break and a lone-break `text` block each emit ONE line and round-trip; a `to-do`
  and a `numbered-list` carrying a break keep their prefix; and **a `code-block`
  still emits three lines** — the regression guard for the encode-site mistake.
- `editor/core/inline-markdown.test.ts:457-479`, the escaping identity test — extend
  its `raw` string with a soft break so `par(ser(x)) === x` covers it. `:451`
  (`par("**a\nb**")` stays one literal run) pins the parse side's newline guards and
  must still pass: a real newline in the input is still not a construct boundary.
- `editor/core/markdown.test.ts:671-676`, the `prompt` two-line body — flips to the
  escaped one-line form under the server dialect. Keep the two-line form as a second
  case under `softBreaks: "newline"`, so both dialects are pinned rather than one
  being replaced by the other. Add a third: a prompt whose text is **bold across a
  break** round-trips, which it does not today.
- `inline-markdown.test.ts:451` (`par("**a\nb**")` stays one literal run) must
  pass unchanged — it documents why the escape exists. Add its twin below:
  `par("**a\\nb**")` yields one bold run holding the break.
- `markdown-apply/core/touched.test.ts` — the regression pin from the last round of
  this bug lives here, and its `noOpApply` helper is scoped inside a `describe` about
  empty paragraphs. **Hoist that helper to module scope** under a heading naming the
  shared invariant (*the identity round trip plans NOTHING*) and give the soft break
  its own sibling `describe`, so both rounds of this bug read as instances of one
  statement rather than one being filed under the other's title. The new pin is this
  incident's minimal repro: two blocks, one holding a break; the read emits two lines,
  not four, and applying it back plans nothing.
- Marks and links across a break, in `inline-markdown.test.ts`: a bold run with an
  **interior** soft break, and a link run containing one, both round-trip exactly. A
  separate case pins the edge behaviour — a marked run ENDING in a soft break
  canonicalizes to the hoisted pair — so the generator below can stay away from it
  knowingly rather than by accident.
- Keep the fuzzer's soft breaks interior to marked runs, for the same reason its
  word list already avoids leading spaces and prefix characters: the hoist is a
  canonical-form rule, not a defect, and the property asserts the exact round trip.
- The four test files carrying local mirror `MarkdownContext` fixtures stop
  compiling when the third required field lands and each needs one line:
  `markdown.test.ts` (4 sites), `markdown-apply/core/{plan,touched,page-title}.test.ts`.

### The follow-up worth doing separately

`agent-access/e2e/agent-access-verify.ts` already asserts this exact invariant with
REAL handles, as **E4**: *"`read_page`'s exact output, fed back as a write, reports
`{created:0, deleted:0, moved:0, text_edited:0}`"*. It passes today only because its
fixture page has no soft break — the same gap as the fuzzer's alphabet, one level up.
Its three prose lines should include one typed with Shift+Enter, which is genuine
browser-authored CRDT state and adds no block.

It is deliberately NOT part of this change, because it is not the one-line fixture
edit it appears to be. `LINES` is used ten ways in that file, and a soft break is the
first content that makes two of those uses diverge: some compare a STORED row's text
(a real `\n`) and others compare the MARKDOWN spelling of it (the escape), including
the `old_string` anchor at `:393` and the `markdown.includes(line)` check at `:468`.
Getting that right means separating "the text" from "its spelling" throughout an e2e
that asserts eight policies, and it deserves its own pass and its own review rather
than being carried in on the back of this one.

**Done** in `research/2026-09-22-page-agent-access-e2e-round-trip-fixture.md`: the
fixture holds a soft-broken line and a line another block type would claim, each
use picks the row's text or its markdown spelling, and a named precondition keeps
E4 from running on a page it cannot fail on.

## Verification

1. `./equin test plugins/page` — the fuzzed round-trip property is the
   executable statement of the contract (`editor/CLAUDE.md:3083` says to extend it
   rather than add one-off cases), so it must pass with soft breaks in the
   generator.
2. `./equin build`, then `./equin check`.
3. **The real repro, end to end — against THIS worktree, not main.** The MCP tools an
   agent calls reach the shared instance, so using them here would exercise main's
   unfixed code. The tool *implementations* are instance-local, though, and a
   worktree's database is a fork of main: all six affected pages are present in it
   with identical break counts. So drive this worktree's own deploy — `read_page` on
   `block-6b4d4ded-7ff6-425f-b9c0-27fb321af109` (*Plugin system*, the page that
   refused every edit), then `edit_page` appending a tagless `<agent-note>` card at
   page level. It must apply, reporting creates only: 0 updated, 0 deleted,
   0 text-edited, `absorbed_writes: 0`.

   This is worth more than the mirror-handle script that found the bug: those pages
   use fifteen block types including `code-block`, `callout` and `place`, and a
   hand-built mirror of those is exactly what a false pass would hide behind. Real
   handles, real rows.

   Before the fix, the same call reports two creates inside `<todo>`
   `block-ee4598f3…` and is refused — that is the before/after pair worth capturing.
4. **The other five pages** must become editable too, since each holds a block with
   an interior soft break: *Todos* (`block-7531e1e2…`, two such blocks), *Website*
   (`block-0bf62402…`), *Why singularity* (`block-5a4bc7a7…`), *Story*
   (`block-6ba6822e…`), *Plugin system* (`block-d21cff26…`). Find them with:

   ```sql
   with runs as (
     select b.id, b.page_id, jsonb_array_elements(b.data->'text') as run
     from page_blocks b
     where b.deleted_at is null and jsonb_typeof(b.data->'text') = 'array'
   )
   select page_id, count(distinct id)
   from runs where run->>'text' like '%'||chr(10)||'%' group by page_id;
   ```

   No migration or data cleanup: the escape represents what is already stored, so
   these rows round-trip as soon as the spelling exists.
5. **The backstop fires on the right input.** Point a test at a hand-built row whose
   text holds a `\n` with the escape disabled, and confirm `edit_page` refuses with
   the projection message naming that row — not with a boundary violation naming a
   card the edit never touched.
6. **The human side is unchanged.** In the editor: Shift+Enter inside a block, copy
   that block, paste into a plain-text field. The break must still arrive as a real
   newline with no `\n` visible. Internal copy/paste goes through the structural
   clipboard flavour and is unaffected either way.
7. `read-only-view` still renders the break as a line break, and the page history
   diff for one of the six pages still shows what it showed before.
