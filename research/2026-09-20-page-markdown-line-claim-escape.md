# A paragraph that starts like a list survives the markdown round trip

*2026-09-20 — page/editor, page/markdown-apply*

## Context

`edit_page` refuses edits nobody made. Again — the third round of one class.

On 2026-09-20 an agent tried to add one `<agent-inline>` card to *[Planned] Installable
by others* (`block-cc11355f`) and was refused by the backstop from
`research/2026-09-10-page-soft-break-markdown-round-trip.md`:

> Reading it out and applying it back completely unchanged would itself create 2
> blocks, so there is no way to tell this edit apart from the round trip's own
> damage. **No stored row's text would be rewritten**, so the loss is in the shape
> the read emitted rather than in one block's text.

Measured, by replaying the page's real rows through the real engine: reading the page
out and applying it back **unchanged** plans

```
delete block-183b07f2  text "3. Investigate the gaps to make it useable. …"
delete block-3d152d33  text "2. User journey for the git clone user"
create numbered-list   (the same words)      ×2
update block-3b30fdbc  (re-parented under the created block)
```

Two paragraphs whose text begins with `3. ` and `2. `. `page/text` serializes a
paragraph as its bare words (`text-block.ts:36`), so the emitted lines are
`3. Investigate…` and `2. User journey…`, and on the way back
`numbered-list.markdown.parseLine` claims them with `/^\d+[.)]\s+(.*)$/`
(`numbered-list-block.ts:21`). The paragraph loses its id, its content doc, its undo
history and its children's parent — so the guard refuses, correctly, and its message
names no row, because the loss produced no text edit to name.

**The class was known and written off.** The fuzzed round-trip property — the
executable statement of *markdown is a lossless projection* — picks its words to dodge
exactly this input (`markdown.test.ts:1967-1970`):

> Words chosen so no generated line can be claimed by a PREFIX parser: nothing starts
> with `- `, `# `, `1. `, `> `, `$$`, `---`, `[ ] ` or a space. **That is a genuine
> (pre-existing) lossiness of markdown itself** — a paragraph reading "- x" is a
> bullet — not of this mechanism.

It is not inherent. CommonMark spells a literal marker with a backslash, and our own
projection claims to be canonical on serialize. The premise is what this change
rejects; the fix is the spelling the premise assumed did not exist.

**What is actually claimable**, after the inline escape table (`inline-markdown.ts:375`)
has already taken `\ * _ ~ ` [ ] <` out of play — so `* x`, `[ ] x`, `` ```x `` and
`<human …>` are safe today and need nothing:

```
- ␠     + ␠     # ␠  ## ␠  ### ␠     > ␠     ^\d+[.)]\s+     ^$$     trim() === "---"
```

(`bulleted-list`, `heading-1/2/3`, `toggle`, `numbered-list`, `equation`, `divider`.)

On main today: **10 paragraphs across 3 pages** are un-editable this way — *Plugin
system* (5), *[Planned] Installable by others* (2), *Baseline run 1 (2026-09-18)* (3),
all of them the `N. ` form. The other markers are latent. No data migration is needed:
the escape spells what is already stored.

## Design

### 1. One claim authority, read by both directions

The bug is possible because the serializer does not know what the parser will do with
the line it just wrote. `parseMarkdownToForest` builds its dispatch at
`markdown.ts:1099-1112` and consumes it at `:1188-1228`. Extract that, next to
`parserFor` (`:940`):

```ts
function claimersOf(handles: Handle[]): Claimers          // the ONE ordering: fence, then precedence desc
function claimantOf(content: string, c: Claimers): Handle | null   // TYPE only — no payload built
```

`claimantOf` probes with a stub context (`{ runs: () => [] }`): every `parseLine` today
uses `ctx.runs` only to fill a field the predicate never inspects, so the answer costs
regex work and never a second `parseInlineMarkdown`. `parseMarkdownToForest` then asks
once and re-invokes that one entry with the real context — one loop, no drift.

It deliberately does **not** model the tag branch: `claimTag` (`:1304`) is multi-line and
can decline after consuming nothing, so it is not a single-line predicate. It does not
need to be — a `lines`-branch line can only start with `<` if a handle emits one, and
none does. That is asserted (A3 below) instead of assumed.

`serializeForestToMarkdown` builds `claimersOf(ctx.handles)` once (`:1581`) and closes
over it. Do not memoise on the handles array: `serverMarkdownContext()` mints a fresh
one per call.

### 2. Serialize: the line a block emits is claimed by that block, or it is escaped

In `renderList`'s lines branch, in the `else` of the empty-block pin (`:1640-1652`), on
the node's FIRST emitted line, dedented:

- `claimantOf(line) === ownerHandle` → emit unchanged.
- else, and the owner is the `defaultText` handle → insert `\` at **index 0**, re-check,
  emit. Every claimer anchors at `^` or compares `trim()`, so index 0 defeats all nine;
  there is no position to search for, and a fixed position is what makes the decode
  exact. Index 0 of the whole line, ahead of any leading whitespace the text carries, so
  `"  ---"` emits `\  ---` and keeps its two spaces.
- else (a non-default owner whose own line is claimed by someone else) → **throw**,
  naming the block type, the line and the claimant. Unreachable today; escaping there
  would silently convert the block to a paragraph, which is the damage this closes.
- still misclaiming after the insert → throw the same way.

**Both probes — this one and the decode's — run on the line with its LEADING WHITESPACE
STRIPPED, and both keep that whitespace in the text they pass on.** The parse loop reads
leading whitespace as indent (`content = raw.slice(ws.length)`) before any claimer sees a
line, but a stored paragraph's own text can begin with spaces and the serializer emits
them inside the line. Probing `"  3. x"` unstripped answers *prose* — `^\d+` does not
match — so nothing is escaped and the line is claimed on the way back exactly as before;
probing the decode's remainder unstripped makes it decline, and the paragraph comes back
with a literal backslash in its words. One shared strip helper, with the escape still at
index 0 of the whole line so the spaces survive. `"  ---"` hides this because `divider`
compares `trim()`; `"  3. x"` does not, and is its own test case.

**"Claimable" means a claimant that is not the default-text fallback.** The claim lookup
answers *prose* for every unclaimed line, so testing definedness would strip a backslash
off every line that begins with one.

### 3. Parse: a leading backslash makes the line prose

Between the fence branch and the claimers loop (`:1212-1214`): if the dedented content
starts with `\` and removing it yields a line `claimantOf` would claim, strip that one
backslash and hand the remainder to the `defaultText` handle — never re-offering it to
the claimers, which by definition would take it.

**Block level, before the inline parse, and it must be.** `isEscapeAt`
(`inline-markdown.ts:731`) only treats a backslash as an escape when the next character
is one of the nine spellings; `3`, `-`, `#`, `>`, `$` are not among them, so the inline
layer is blind to this escape by construction and there is no double-decode. The
remainder handed to `ctx.runs` is byte-identical to what the serializer produced before
the insertion.

`inline-markdown.ts` does not change. Adding `-`/`#`/`>` to `ESCAPES` would emit
`well\-known` for every hyphen in every word — the table is per-character and
position-blind, and the ownership line is already drawn in its header (`:282-285`:
*block-level syntax is `markdown.ts`'s concern*). Say so there, with a pointer, so the
next person does not try.

Decoding is unconditional in every dialect — the module's stated asymmetry, *lenient on
parse, canonical on serialize*. There is no leniency cost this time: `\- x` in foreign
pasted markdown means a literal `- x` paragraph in CommonMark too, so the decode makes
us *more* faithful to a pasted document, not less.

### 4. One spelling, no fourth dialect

No new `MarkdownContext` field. `\3. Investigate` is correct CommonMark and renders as
the paragraph it is wherever a person pastes it, so the clipboard is better with the
escape, not worse — which is exactly what made `emptyBlocks` and `blankLines` dialects
and lets this one avoid being one.

The **asserts** are gated on `softBreaks === "escaped"`: the clipboard dialect is
deliberately lossy and must never throw during a Cmd+C.

Rejected: emitting the block as its tag (`<text>3. Investigate…</text>`, the
`emptyBlocks: "pinned"` and `prompt` precedents). It is more general — it can spell any
owner, which the escape cannot — but it needs the fourth dialect so no human ever pastes
a tag, it gives an ordinary paragraph a second shape that every agent splicing
`old_string` must handle, and moving `text` to `body: "text"` touches `<text/>`'s parse
and the pin. Its generality is taken as the throw in §2 instead of as a second spelling.

### 5. The asserts that close what the claim check cannot see

- **A2 — one line.** In the escaped dialect, a `lines`-branch node whose handle declares
  no `markdown.fence` emits exactly one line; else throw naming the type. This closes a
  live second instance of the class: `equation` serializes `"$$" + expression`
  (`equation-block.ts:18`) from a textarea, so a multi-line LaTeX expression fans out at
  `markdown.ts:1651` and lines 2..n come back as created paragraphs — the soft-break bug
  again, on a different type. `code-block` is the one exemption, self-delimiting through
  its fence. The comment at `:1641-1650` already claims this property; A2 makes it true.
- **A3 — a `lines` line never opens with `<`.** One `startsWith` check; it is what lets
  `claimantOf` skip the tag arm honestly.

Known, absorbed residual, stated rather than discovered: `equation`'s `parseLine` does
`slice(2).trim()`, so `$$ x ` round-trips to `x`. That is a data-level drift the type
check cannot see; it lands as an `update` keyed by the row id, which `subtractNoise`
cancels, so it can never refuse an edit.

### 6. Declaring a line claim means declaring what it claims (the rung-2 guard)

```ts
parseLine?: { claims: readonly string[]; parse(line: string, ctx: MdParseCtx): T | null }
```

Not for tidiness — the samples are the only thing that can *prove* the escape correct.
A check over the real registry then asserts, for every declared sample and for every
`prefix + "x"` synthesised from `markdownPrefixes` (so prefix claimers declare nothing
new):

1. the sample is claimed by its own declarer — which also pins the precedence order
   (`to-do` over `bulleted-list` on `- [ ] x`) that nothing checks today;
2. **`"\\" + sample` is claimed by nobody** — the escape's correctness proof, and the one
   fact underivable from `markdownPrefixes`;
3. `sample[0]` is not an `ESCAPES` spelling — today's disjointness is load-bearing and
   currently accidental. The spelling set contains `n`: a future claimer on `note: `
   would have the serializer emit `\n…`, one ordering mistake away from a soft break.

Rejected alternatives: deriving the escape position from a declared pattern (two
spellings of one claim that can drift, and the position is always 0); forbidding a
`parseLine` broader than its `markdownPrefixes` (`^\d+[.)]` and `trim() === "---"` are
not prefixes, and `markdownPrefixes` must stay literal strings for
`conversionPrefixesOf` and `page.editor:block-prefixes-unique`).

### 7. Which rung holds what: the property stays a test, the declarations get a check

**What actually let the bug through is the alphabet, not the mirror.** `markdown.test.ts`
does build its own 24-handle mirror with `defineBlock` (`:330-355`) — a static import of
the block plugins' cores from `editor/core` would be a cycle (each of them imports
`defineBlock`) and the boundary checker scans test files, which the comment at `:25-31`
states. But the mirror is FAITHFUL where it counts: its `numbered-list` (`:85-97`) is
byte-identical to the real declaration, `/^\d+[.)]\s+(.*)$/` included. Had the generator
ever produced the word `3. x`, the property would have failed. It could not, because the
word list forbids it on purpose.

So the round-trip property stays exactly where it is — a fuzz test, over the mirror,
with the exclusion deleted (§ *Files*, item 8). Putting a fuzzed forest property inside
a `check/` would be a test in a check's clothing, and checks are cached by signature and
expected to be deterministic.

What the new check owns is a different kind of statement — a **deterministic invariant
over the real declarations**, which is rung 3 on the fix ladder and the same shape as the
two checks already sitting there (`markdownTagNamesUnique`, `blockPrefixesUnique` in
`plugins/page/plugins/editor/check/index.ts`): for every real handle, its declared claim
samples are claimed by it, the escaped form of each is claimed by nobody, and no sample
opens with a character the inline escape table spells. That needs the REAL handles
(a mirror can only prove the mirror), it is data rather than a search, and `check/` is
the only rung that can both enumerate the registry and call its functions — a lint rule
cannot, because jiti cannot resolve `@plugins/*` for a contributed rule. `collectBlockHandles()`
is already there, dynamically importing every plugin's web barrel, with a
fail-loud-on-empty-set branch to copy.

**Mirror drift stays a real, second-order risk** — nothing forces the mirror to follow a
real handle that changes. If we want that closed too, it does NOT need the property to
move into a check: `importBarrel` is a public barrel
(`@plugins/plugin-meta/plugins/barrel-import/core`, a leaf that depends on nothing in
`page/`), so a test may load the real block barrels DYNAMICALLY and run the round trip
over them without any static edge and therefore without a cycle. That is the belt-and-
braces option; it costs a slow test that imports every web barrel, and it is listed last
(item 10) rather than assumed.

### 8. The refusal, when something still cannot be spelled

Keep the hard refusal where it is (`apply.ts:428`) and give it the sentence it was
missing. Today it lists the rows the identity plan would REWRITE, which for a
line-claim loss is the empty set — the message named nothing. It should also name the
rows the identity plan would **delete**, which in this class is precisely the offending
block, with its stored-text preview and the type that stole it.

The read side deliberately does **not** throw. `readBlockAsMarkdown` re-planning its own
output would turn a lossy-but-readable page into a 409 on the *safe* operation, and its
four callers include page-instructions delivery and todo→agent dispatch, neither of
which needs a writable round trip. The serializer's own claim check and A2 fire at the
point of damage, in both runtimes, on every path. Optionally, and last: a non-fatal
`recordReportDebounced` from the read comparing node count + type sequence against
`markdownNodesOfRows` — O(n), no ids minted, page stays readable. It adds a
`markdown-apply/server → reports/server` edge that does not exist today; call that out in
review.

## Files to change, in order

1. **`plugins/page/plugins/editor/core/markdown.ts` — extract, no behaviour change.**
   `Claimers`, `claimersOf`, the probe context, `claimantOf`, placed after `parserFor`
   (`:940`); rewire the build (`:1099-1112`), the fence arm (`:1188-1212`) and the claim
   arm (`:1214-1228`) onto them. The suite must be green with **zero test edits** — that
   is the proof it is a refactor.
2. **`markdown.ts` — the parse-side decode** (§3), between `:1212` and `:1214`. Ships
   before the encode, so a document written by the new serializer is readable by the
   deploy that precedes it.
3. **`markdown.ts` — the serialize-side escape and asserts** (§2, §5), in `renderList`'s
   lines branch, in the `else` of the pin (`:1640-1652`).
4. **`markdown.ts:369` + `define-block.ts:76-81`** — `parseLine` becomes the
   `{ claims, parse }` pair; `parserFor` (`:924`) reads `.parse`.
5. **The four claiming handles** — `numbered-list-block.ts:20` (`["1. x", "10) x"]`),
   `to-do-block.ts:21` (`["- [ ] x", "[ ] x", "* [X] x"]`), `divider-block.ts:21`
   (`["---"]`), `equation-block.ts:18` (`["$$x"]`), plus the mirror fixtures in
   `markdown.test.ts` (`:76, :91, :311, :323`) and `markdown-apply/core/plan.test.ts`
   (`:74, :142`).
6. **`plugins/page/plugins/editor/check/index.ts`** — the new
   `page.editor:markdown-claims-are-escapable` (§6, §7) beside `blockPrefixesUnique`
   (`:590`), registered in the default export.
7. **`plugins/page/plugins/markdown-apply/server/internal/apply.ts`** — the refusal names
   the identity plan's deleted rows and the claiming type (§8).
8. **`markdown.test.ts:1967-1989`** — build the fuzz alphabet FROM the declared claim
   samples × every text-bearing type, instead of dodging them; delete the now-false
   `[ ] `/`* ` clause; keep the leading-space and soft-break-at-word-edge exclusions,
   which are genuine canonical-form rules.
9. **Docs** — `editor/CLAUDE.md`'s *Markdown is a LOSSLESS PROJECTION* section gains the
   line-claim bullet beside the blank-line and soft-break ones; `inline-markdown.ts:282`
   gains the pointer saying where the line escape lives and why it must not move there;
   `agent-access/server/internal/mcp-tools.ts`'s `read_page` / `edit_page` descriptions
   gain one sentence — a leading `\` before `-`, `+`, `#`, `>`, `$$`, `---` or `N.` marks
   a plain paragraph, and handing it back unchanged is not a write.
10. **Optional, last** — the read-side non-fatal report (§8), and the mirror-drift test
    that loads the real block barrels through `importBarrel` (§7).

## Tests

- **Flat lines** (`markdown.test.ts`): a `text` block reading each of `3. x`, `10) x`,
  `- x`, `+ x`, `# x`, `## x`, `> x`, `$$x`, `---`, `  ---` emits ONE line beginning `\`,
  round-trips exactly, and is idempotent on a second cycle.
- **The already-safe set gains no escape**: `* x`, `[ ] x`, `` ```x ``, `<page id="p1"/>`
  as literal text — proving the check reads the *escaped* line, not the run text.
- **Literal-backslash fixed points**: `\- foo`, `\3. x`, `\\- foo` emit, parse and
  re-emit byte-identically.
- **Owner-preserving**: `numbered-list` text `2. x` → `1. 2. x`; `heading-1` text `# x`;
  `to-do` text `- [ ] y`; `bulleted-list` text `- z` — no escape, type preserved.
- **`code-block` still emits three lines** and is not escaped (the fence-arm regression).
- **A2 fires**: an `equation` whose expression holds a `\n` throws in the escaped
  dialect, naming `equation`; the same node in the clipboard dialect does not throw.
- **§2's throw fires**: a fixture handle whose serializer emits a line its own parser
  declines throws rather than being escaped into a paragraph.
- **The fuzz property** with the widened alphabet, exact and idempotent.
- **`inline-markdown.test.ts`**: `\-`, `\3`, `\#`, `\>`, `\$` parse as literal backslash
  plus character — the inline layer stays blind to the block escape.
- **`markdown-apply/core/touched.test.ts`**: a sibling `describe` under the existing *the
  identity round trip plans NOTHING* heading, with this incident's minimal repro — two
  blocks, one reading `3. Investigate the gaps`; the read emits two lines and applying it
  back plans nothing.
- **`markdown-apply/core/plan.test.ts`**: an incoming `\3. x` line pins to the stored
  `text` row rather than creating.
- **`./equin check page.editor:markdown-claims-are-escapable`** must fail if a bogus
  `claims: ["x"]` entry is added to any handle.

## Verification

1. `./equin test plugins/page`, then `./equin build`, then
   `./equin check`.
2. **The real repro, against THIS worktree's deploy, not main** (the MCP tools reach the
   shared instance, which runs main's unfixed code; a worktree DB is a fork and holds the
   same pages). `read_page` on `block-cc11355f` (*[Planned] Installable by others*), then
   `edit_page` appending a tagless `<agent-inline>` card. It must apply, creates-only,
   `absorbed_writes: 0`. Before the fix the identical call is refused by `apply.ts:428`.
3. **The other two pages** must become editable: *Plugin system* (`block-6b4d4ded`, 5
   blocks) and *Baseline run 1 (2026-09-18)* (`block-eae9ee6c`, 3). Enumerate with:
   ```sql
   select b.page_id, b.id, left(b.data->'text'->0->>'text', 60)
   from page_blocks b
   where b.deleted_at is null and b.type = 'text'
     and ((b.data->'text'->0->>'text') ~ '^(\d+[.)][ \t]|[-+][ \t]|#{1,3}[ \t]|>[ \t]|\$\$)'
       or btrim(b.data->'text'->0->>'text') = '---');
   ```
4. **The human path.** Copy a paragraph reading `3. Investigate` out of the editor and
   paste it into a plain-text field: it arrives as `\3. Investigate`. That is the one
   user-visible artifact of choosing the escape, it is correct CommonMark, and it renders
   as `3. Investigate` in any markdown reader. Internal copy/paste is unaffected (it
   travels as the structural clipboard payload).
5. **The backstop still fires on the right input.** With the escape disabled on a
   fixture, `edit_page` refuses naming the *deleted* row and the claiming type — not an
   empty candidate list, as it did on 2026-09-20.

## Follow-up, deliberately separate

`agent-access/e2e/agent-access-verify.ts`'s **E4** — *`read_page`'s exact output, fed back
as a write, reports `{created:0, …}`* — passes today only because its fixture page has no
claimable line, the same gap as the fuzzer's alphabet one level up. Adding one means
separating "the text" from "its spelling" across the ten uses of `LINES` (the
`old_string` anchor and the `markdown.includes(line)` check in particular), which is its
own pass — the same call the precedent doc made about its own E4 gap.
