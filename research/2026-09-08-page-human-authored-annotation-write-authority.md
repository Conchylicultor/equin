# Human-authored annotations, and the write authority that protects them

**Date:** 2026-09-08
**Category:** page
**Status:** proposed

## Context

Today an agent may rewrite anything inside an `<agent-note>` card. The
`agent-access` plugin states this as a residual bound, in its own words:

> **The residual bound, stated rather than hidden:** an edit whose diff stays
> inside a card may rewrite that card wholesale, including anything a HUMAN
> typed into it.

So there is no way to answer an agent *inside its own note* — to correct a
finding, to say "no, the writer is in `encode.ts`" — and have that answer
survive. The next `write_agent_note` overwrites it. The only protected lane is
`/private`, which the agent never sees at all, so it cannot carry a reply.

What is missing is the third state: **text the agent must read and must never
write.**

That state already exists in the family without being enforced. `/context` is
standing instructions the human writes for the agent; `/todo` is work the human
assigns. Both are the human's words, and both are only accidentally safe — they
are unwritable because they usually sit in the page's prose, not because
anything says so. Nest either one inside an agent's card and the agent can
rewrite it.

This design adds the missing declaration rather than a fifth card:

- every annotation declares **who authors it** (`author: "human" | "agent"`),
  alongside the `audience` it already declares;
- the agent-write rule becomes **the nearest declaring ancestor wins**, so a
  human-authored card nested inside an agent's card is a hole the agent cannot
  write into;
- `/context` is renamed to **`/human`** — the author is now the load-bearing
  fact, and the card's job was never only "context". `/context` and `/user`
  survive as aliases. Its markdown tag becomes `<human>`, so an agent reading a
  page can see whose words it is looking at.

### The decisions behind the naming

**`human`, not `user`.** The repo already runs one axis end to end: the family
doc's "human ↔ agent", the `BlockAudience` union, and the new `author` union all
spell it `"human" | "agent"`. Naming the card `user` would give one actor two
words, and the doc would have to say "the user card declares `author: human`".
`<human>` beside `<agent-note>` is also a clean opposition in the markdown an
agent reads. `user` and `context` are kept as `/` aliases, so nobody has to
learn the change.

**The stored `type` stays `"context"`.** Only the directory, the symbol, the
label, the corner chip and the markdown tag are renamed. `BlockTag.name` exists
precisely so a tag may differ from a type, and keeping the stored value means no
data migration over prod page rows and no lost reorder directives (the
`Editor.Block` contribution id is the type). One comment in the block file
records it, mirroring the note `agent-note` already carries about its own
type-vs-symbol split.

## Design

### 1. A second declared fact: who authors this card

`plugins/page/plugins/editor/core/define-block.ts`

```ts
/** Whose words a block holds — and therefore who may write it. */
export type BlockAuthor = "agent" | "human";

interface BlockHandle<T> {
  audience?: BlockAudience;   // may an agent RECEIVE this
  author?: BlockAuthor;       // whose words these are
}
```

The two absent-value defaults point in opposite directions, and both are the
fail-safe one:

| absent | means | why it is safe |
|---|---|---|
| `audience` | ordinary content, visible to everyone | a paragraph is withheld from nobody |
| `author` | **the human's** | the page's prose is not the agent's to rewrite |

`defineBlock` accepts neither, so presence remains the proof a type went through
`defineAnnotationBlock` — the discriminator the family check keys on.

### 2. The family declares it

`plugins/page/plugins/annotations/core/define-annotation-block.ts` — `author`
joins `audience` as a REQUIRED field on `AnnotationBlockOptions`, landing on
`AnnotationBlockHandle`.

| card | `audience` | `author` |
|---|---|---|
| `/agent` | `agent` | **`agent`** |
| `/human` (was `/context`) | `agent` | `human` |
| `/todo` | `agent` | `human` |
| `/private` | `human` | `human` |

`/agent` is the only card in the system an agent authors. That single row is what
the whole write rule reduces to.

`plugins/page/plugins/annotations/check/index.ts` — the existing check asserts
both fields and is renamed `annotations:audience-declared` →
`annotations:parties-declared` (two CLAUDE.md references to update).

### 3. The engine's boundary predicate goes three-valued

`plugins/page/plugins/markdown-apply/core/touched.ts` — still names no block
type, still returns violations rather than throwing.

```ts
/** What a row declares about writes inside it. `undefined` — it declares nothing. */
export type WriteBoundary = "open" | "closed";

boundaryViolations(args: {
  plan; existing; rootId;
  boundaryOf: (row: { id: string; type: string }) => WriteBoundary | undefined;
})
```

`reachesBoundary` becomes `nearestBoundary(...): WriteBoundary | "none"` — the
same self-inclusive walk, the same `rootId` ceiling and the same
corruption-throws bound, but it stops at the **first row that declares
anything** instead of at the first row that says yes. Nearest wins, so a closed
card inside an open one shields its contents, and an open card inside a closed
one (an `<agent-note>` a human nested in a `<human>` card) still works.

`BoundaryViolation` splits its one overloaded field into the two facts it was
carrying:

```ts
{ blockId, how, side: "new" | "old", reason: "escaped" | "enclosed" }
```

`"escaped"` — the chain declared nothing (today's `escaped`). `"enclosed"` — the
chain hit a **closed** card first. `side: "old"` replaces the `-origin` suffix,
which also removes the special case that made a delete's old-chain failure
report as `escaped` rather than `escaped-origin`.

Reuse note: `boundaryViolations`, `assertAcceptable`, `redact` and `baseline`
have exactly one caller in the repo (`agent-access`), so this is a contained
signature change. The mechanism's spec is
`plugins/page/plugins/markdown-apply/core/touched.test.ts`, which already builds
a synthetic identified void container (`fence`) for its cases — the closed-side
cases get a second synthetic type there, not a real block.

### 4. The policy: rules 1 and 3 collapse into one walk

`plugins/page/plugins/annotations/plugins/agent-access/server/internal/policy.ts`

New, beside `humanAudienceTypes()` and read at call time for the same reason:

```ts
function writeBoundaryOf(row: { type: string }): WriteBoundary | undefined {
  // author === "agent" → "open"; author === "human" → "closed"; none → undefined
}
```

A degraded registry now means *nothing is open*, i.e. refuse every write — the
fail-safe direction, where the same degradation for `audience` would have meant
"redact nothing".

`assertNotesOnlyPlan` loses **rule 1** entirely. "Nothing may mint a
human-audience card" was a separate walk over the plan's creates and retypes;
under the new rule a created (or retyped-into) `private-note`, `human` or `todo`
declares `closed` at its own row, so the self-inclusive walk refuses it as an
`enclosed` violation. Rules 1 and 3 become the same walk with the same evidence,
which is the real simplification here — the two invariants stop being two.

Kept as-is: **rule 2** (notes do not nest — a parent-walk genuinely about
`agent-note`), `assertNoteCard` (`write_agent_note`'s door), `redactHumanAudience`,
and `nearestCard` for authorship stamping.

`violationMessage` gains the `enclosed` arms, which can be precise because the
violation names the block and the after-forest knows its type:

- created/retyped closed card → *the document creates a `<human>` card, which
  holds the page author's own words — an agent may not author one. Write what
  you have to say in your own `<agent-note>` card instead.*
- write inside a closed card → *block X sits inside a `<human>` card. Those are
  the page author's words, even inside your own note: read them, leave them
  byte-identical.*
- `side: "old"` + `enclosed` → *this edit moves a block OUT of a `<human>`
  card.*

### 5. What this changes for an agent, stated plainly

- An agent can no longer create, edit, move or delete anything inside a
  `<human>` or `<todo>` card — including one nested in its own `<agent-note>`.
- An agent can no longer **mint** a `<human>`, `<todo>` or `<private-note>` card
  anywhere. Previously it could mint a `<todo>` or `<context>` inside its own
  card; that is the deliberate cost of the generalization. Filing work is
  `add_task`.
- `write_agent_note` on a card that contains a `<human>` card now requires the
  agent to echo that card back verbatim — omitting it plans a delete, which is
  refused with nothing written. The card is `identified: true` (like
  `<agent-note>`), so `read_page` emits `<human id="…">` and the applier pins it
  by id rather than inferring identity from content.
- Everything else is unchanged: reads still show `<human>` cards in full, and an
  agent's own card is still wholly its own.

### 6. The block rename

`git mv plugins/page/plugins/annotations/plugins/{context,human-notes}`

```ts
export const humanNotesBlock = defineAnnotationBlock({
  type: "context",            // STORED value, deliberately unchanged — see above
  label: "Human",
  icon: MdPerson,             // was MdRule
  audience: "agent",
  author: "human",
  aliases: ["context", "user", "me", "mine",
            "instructions", "guidance", "conventions", "rules"],
  markdown: { tag: { name: "human", body: "children", identified: true } },
});
```

- `contextBlock` → `humanNotesBlock`, `contextDataSchema` → `humanNotesDataSchema`,
  `ContextFrame`/`ContextAnchor` → `HumanNotesFrame`/`HumanNotesAnchor`, corner
  chip `"Context"` → `"Human"`, package name → `…-annotations-human-notes`.
- **Hue unchanged** (`bg-muted/50`, `text-muted-foreground`). Neutral is right
  for the page's own voice — every other semantic hue carries a status
  connotation the family doc explicitly documents, and a nested `muted` card
  stays legible against `agent-note`'s `bg-info/10`.
- No registry edits: `./equin build` regenerates `web.generated.ts` /
  `server.generated.ts` from the filesystem.

### 7. Tool descriptions

`agent-access/server/internal/mcp-tools.ts`:

- `read_page` — a paragraph saying `<human>` and `<todo>` cards are the page
  author's own words: read them, never write one, not even inside your own card.
- `edit_page` — THE ONE RULE gains its second half: every block the edit touches
  must sit inside an `<agent-note>` card **and not inside a `<human>` or
  `<todo>` card within it**. Add a fifth worked example showing the refusal.
- `write_agent_note` — echo any `<human id="…">` card in the target back
  verbatim.

## Files

| file | change |
|---|---|
| `plugins/page/plugins/editor/core/define-block.ts` | `BlockAuthor`, `BlockHandle.author` |
| `plugins/page/plugins/annotations/core/define-annotation-block.ts` | required `author` |
| `plugins/page/plugins/annotations/check/index.ts` | assert both fields; rename check id |
| `plugins/page/plugins/markdown-apply/core/touched.ts` | `boundaryOf`, `WriteBoundary`, `{side, reason}` |
| `plugins/page/plugins/markdown-apply/core/touched.test.ts` | closed-boundary cases |
| `…/annotations/plugins/agent-access/server/internal/policy.ts` | `writeBoundaryOf`, drop rule 1, new messages |
| `…/annotations/plugins/agent-access/server/internal/policy.test.ts` | closed-card fixtures |
| `…/annotations/plugins/agent-access/server/internal/mcp-tools.ts` | tool descriptions |
| `…/annotations/plugins/context/**` → `…/human-notes/**` | rename + `author` |
| `…/annotations/plugins/{agent-notes,todo,private-notes}/core/*-block.ts` | add `author` |
| CLAUDE.md: `annotations`, `agent-access`, `human-notes`, `markdown-apply` | rewrite the affected sections |

## Verification

1. `./equin check` — `annotations:parties-declared`,
   `page.editor:markdown-tag-names-unique` (the `human` name is unclaimed),
   `page-editor:anchor-has-decoration`, `type-check`.
2. `./equin test plugins/page/plugins/markdown-apply plugins/page/plugins/annotations`
3. `./equin build` (background), then on a scratch page:
   - `read_page` a page holding a `<human>` card inside an `<agent-note>` — both
     appear, the `<human>` card carries an id.
   - `edit_page` changing text inside the `<human>` card → 403 naming the card.
   - `edit_page` creating a `<human>` card → 403 naming authorship.
   - `write_agent_note` omitting the `<human>` card → 403, and `query_db` shows
     the rows untouched.
   - `write_agent_note` echoing it back → succeeds, human card's id unchanged.
4. `./equin run …/annotations/e2e/annotations-verify.ts` (the `MEMBERS`
   entry becomes Human) and `…/agent-access/e2e/agent-access-verify.ts`, extended
   with a nested-`<human>` case asserting the 403 and a zero-change row snapshot.
5. In the browser at `http://<worktree>.localhost:9000`: `/human`, `/user` and
   `/context` all mint the card; the corner chip reads Human on hover.
