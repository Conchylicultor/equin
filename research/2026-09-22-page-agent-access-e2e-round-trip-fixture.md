# The agent-access E2E's round-trip check gets a page it can fail on

*2026-09-22 — page/annotations/agent-access (e2e), page/editor (e2e helper)*

## Context

`agent-access/e2e/agent-access-verify.ts` asserts, as **E4**, that `read_page`'s
exact output fed back as an `edit_page` plans `{created:0, deleted:0, moved:0,
text_edited:0}`. It is the only place that invariant is checked against the real
deployed block registry.

Its fixture page is three typed paragraphs: `alpha one`, `bravo two`,
`charlie three`. For those three lines, the stored text and the markdown spelling
are the same string. So E4 passes on any serializer. It passed through both losses
it exists to catch:

- **Soft line break** (`3cd91b8eb`, `research/2026-09-10-page-soft-break-markdown-round-trip.md`).
  A Shift+Enter inside a paragraph was written as a real newline. On the way back
  that became two sibling blocks.
- **Line claim** (`3aed9625a` / `d4491d0cd`). A paragraph starting `2. …` was
  written raw. On the way back it parsed as a numbered-list item: one delete and
  one create.

The soft-break doc deferred this fix on purpose ("The follow-up worth doing
separately"). The reason: `LINES` is used about ten ways in the file. Once a line's
text and its markdown spelling differ, each use has to pick the right one.

## The ten uses, sorted

| Where | What it compares | Needs |
|---|---|---|
| typing loop (`:598`) | keystrokes | **typed** form (Shift+Enter for the break) |
| `proseIds` / "three prose blocks typed" (`:610-616`) | block count | `PROSE.length` |
| card mint `old_string` / `new_string` (`:635-639`) | markdown anchor | **spelling** |
| P1 `markdown.includes(line)` (`:710`) | the read | **spelling** |
| T3 `closeThenProse` / `proseIntoCard` (`:791-792`) | markdown anchor | **spelling** |
| P2 "rewriting a prose block" `old_string` (`:818`) | markdown anchor | **spelling** |
| E1 `rowText(row) === LINES[i]` (`:941`) | stored row | **text** |
| E3 rendered `innerText` vs `LINES` (`:982`) | the DOM | **text** (a `<br>` reads back as `\n`) |
| P9 agent-page mint `old_string` / `new_string` (`:1157-1159`) | markdown anchor | **spelling** |

## Design

### 1. `LINES` stops existing. Each line carries both forms.

```ts
/** One prose line: what the row stores, and how `read_page` spells it. */
interface ProseLine { text: string; md: string }

const PROSE: readonly ProseLine[] = [
  // Shift+Enter inside one paragraph: ONE block whose text holds a `\n`. The
  // read spells the break as the two characters `\n`, so the block stays one line.
  { text: "alpha one\nstill alpha", md: "alpha one\\nstill alpha" },
  { text: "bravo two", md: "bravo two" },
  // Typed as prose: only `1. ` is a typing shortcut, so `2. ` stays a paragraph.
  // A numbered list would claim this line on parse, so the read escapes it.
  { text: "2. charlie three", md: "\\2. charlie three" },
];
```

Removing `LINES` is the point. With both forms spelled out, no use can compare
the wrong one by accident. Each use in the table picks `.text` or `.md`.

The spellings are written out by hand, not computed with the serializer. The test
states the contract independently. If it called the code under test to get the
expected value, the check would agree with whatever that code does.

Line placement:
- **`[0]`, the soft break**, is the anchor for P2 and for the P9 page mint.
- **`[1]`, plain**, is the anchor the card is minted after — the first write,
  BEFORE E4. It must not depend on a spelling: when it did (the first draft put
  the line claim here), a lost escape made the anchor unfindable and the run
  bailed there, before anything named what was lost.
- **`[2]`, the line claim**, is what T3's re-indent attack moves under the card
  (`  \2. charlie three`), after E4.

### 2. Typing: `typeLines` learns the soft break

The file hand-types with `type(line)` / `press("Enter")` / a 150 ms settle. That is
the pattern `editor/e2e/support/type-lines.ts` was written to replace, and its
module comment says the settle hides bugs. Extend the shared helper once:

- A `\n` inside a `TypedLine`'s text is typed as **Shift+Enter**. So a line's
  `text` is exactly what the block will store. Today `keyboard.type("\n")` presses
  a plain Enter, which is a block split: a second way to spell `press("Enter")`.
- Grep the 24 existing callers first. If any passes a `\n` expecting a split, move
  it to separate lines.

The fixture is then typed with `typeLines(page, PROSE.map((p) => p.text))`.

### 3. The fixture proves it can fail (non-vacuity)

Add checks, read off live data rather than off the constants, that the page really
contains what E4 needs:

- **After typing:** each prose row stores exactly `PROSE[i].text`. The soft break
  must be one row with a `\n`, not two rows. This moves E1's text check to the
  start, where a failure means "the fixture is not what it claims to be".
- **After the first `read_page`** (replacing P1's `includes`): each `PROSE[i].md` is
  a **whole line** of the markdown (`markdown.split("\n")`). A substring match
  would pass if the break were fanned out or the escape dropped. A whole-line match
  fails in both cases.
- **Right before E4, named as E4's precondition:** "the page holds a prose row
  whose text contains a soft break, and one whose markdown line starts with an
  escape". It is computed from `fetchBlocks` and the read. Whoever later simplifies
  the fixture back to plain words gets a named failure, not a silent pass.

### 4. Docs

- The file header's E4 paragraph says what the fixture must hold and why. Any
  future loss class (the next escape, the next fan-out) is added as one more
  `PROSE` entry.
- The soft-break research doc's "follow-up worth doing separately" section gets a
  closing line pointing here.

### Out of scope

- **Inline escapes** (`<`, `*`, `[`): also text ≠ spelling, but no round trip has
  lost them yet. Adding one later is one more `PROSE` entry.
- **The instructions card losing `{global: false}`** (found by `ebea12bf8`): a data
  loss on a human card, not prose. That needs its own fixture and fix.

## Critical files

- `plugins/page/plugins/annotations/plugins/agent-access/e2e/agent-access-verify.ts`: `LINES` → `PROSE`, typing, the non-vacuity checks, header.
- `plugins/page/plugins/editor/e2e/support/type-lines.ts`: `\n` → Shift+Enter.
- `research/2026-09-10-page-soft-break-markdown-round-trip.md`: closing pointer.

Reused: `typeLines`, `editableBlocks` / `blockIdOf` (`editor/e2e`), `fetchBlocks` /
`rowText` / `snapshot` (already in the file), `plainOf` (`editor/core`).

## Verification

1. `./equin build` (backgrounded), then
   `./equin run plugins/page/plugins/annotations/plugins/agent-access/e2e/agent-access-verify.ts`.
   Every check passes, including the new precondition.
2. **Prove it can fail.** Once, locally and never committed, disable the
   line-leading escape in `editor/core/markdown.ts`, rebuild, and rerun. E4 must
   now fail, with a create and a delete. Restore the escape and rebuild. Without
   this step, "the check now exercises the invariant" is only asserted. It costs
   two extra builds, ~20 min.
3. Run the other e2e scripts that call `typeLines` and are affected by the helper
   change: a quick `rg`, then run any caller that passes a `\n`.
4. `./equin check` (type-check, lint, plugin docs in sync).

## Outcome (2026-09-22)

- Green build: all 99 checks pass, including the new fixture and precondition
  checks.
- Escape disabled, rebuilt: the run fails at the card mint, the first page-rooted
  edit. `markdown-apply`'s own round-trip refusal fires ("would drop stored row …
  ("2. charlie three") outright and create 1 numbered-list block instead"). The
  engine already asks the round-trip question before every write. So on a page
  that holds loss-prone content, a loss fails at the first write, naming the row.
  E4 remains the assertion that a round trip the engine accepts is also a fixed
  point. That failure point is recorded in the file header.
- The soft-break mutant was not run separately. The two share one mechanism, and
  the P1 whole-line check plus the precondition cover it.
