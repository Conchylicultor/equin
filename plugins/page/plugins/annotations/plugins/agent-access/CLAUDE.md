# agent-access

The **agent-facing surface of a page**: three MCP tools over
[`page/markdown-apply`](../../../markdown-apply/CLAUDE.md)'s engine, shaped as
the file triple an agent already knows.

```
read_page(block_id)                              → subtree markdown; human-audience subtrees pruned,
                                                   `# Title`, `<agent-inline id="…">`, `<human id="…">`,
                                                   `<agent-page id="…" title="…"/>` and `<page id="…" title="…"/>` emitted
write_agent_note(block_id, content)              → merge-apply ONE agent-authored block's whole contents
edit_page(block_id, old_string, new_string, …)   → ANY block; legality is what the diff TOUCHED
```

It lives under `annotations` because it is the filter over THIS family: "withhold
`/private`", "own `<agent-inline>` and `<agent-page>`" and "leave `<human>`
alone" are all statements about the two-axis family, not about markdown. The engine stays agnostic — it
takes a root, a row filter and a row classifier, and never learns what an
audience or an author is.

`read_page`'s ids are what make the triple compose. A file path exists before you
read the file; a block id did not, so `read_page` + a write tool used to be two
tools with no shared vocabulary — the only anchor an agent could name was the
page root it started from. Emitting `<agent-inline id="…">` (and the page
pointers) gives the read an output the write tools take as input, which is the whole reason
the two sections below reverse what they reverse. Design:
[`research/2026-08-07-page-agent-note-file-like-tools.md`](../../../../../../research/2026-08-07-page-agent-note-file-like-tools.md).

## The database is the SHARED one, and that is the point

These tools touch `db` directly, and the MCP server runs in the instance that
**launched** the conversation (`.mcp.json` dials `SINGULARITY_PARENT_HOST`) —
normally main. So a page write lands in main's store, never the agent's fork.

Intended: pages are **prod documents an agent edits collaboratively with the
user**, not fixtures to test on. A worktree-local copy would be one nobody reads.
`query_db` defaults the other way (the agent's own fork) because it inspects what
the agent is building — same server, opposite default, which is why all three
descriptions open by saying so.

## Addressing is NO LONGER the authorization — for WRITES. Deliberately

> **This section reverses a recorded decision.** It used to read: *"Writes are
> not restricted by validating the patch they produce. They are restricted by
> what an agent can **name**."* That rule is gone, on purpose, and restoring it
> would remove the feature rather than harden it. Read the rest of this section
> before reaching for it again.

**What the old rule was.** A write tool accepted only a block whose type is
`agent-note`, and the engine was scoped to that block's subtree. An agent could
not rewrite a paragraph because no tool took a paragraph's id. Structural, cheap
to state, and impossible to get wrong.

**Why it went.** It also made the thing this surface exists for impossible. An
agent asked to annotate *a specific line* could not: a line's id was not
something any tool accepted, and `read_page` did not emit one anyway. The only
route to a line was `query_db` — a documented *debugging* tool — as a workflow
dependency. The rule was not buying safety at the margin; it was buying it by
removing the feature.

**What replaced it.** `edit_page` takes **any** block id, up to and including the
page's own. The id is only the SCOPE the edit is applied at. Legality is decided
afterwards, on the plan:

> Every block an edit creates, rewrites, moves or deletes must sit inside an
> agent-authored block — an `<agent-inline>` card or an `<agent-page>` — and not
> inside a `<human>` or `<todo>` card within it — checked on **BOTH** the block's
> old and its new ancestry for anything that survived, so an edit cannot drag the
> page's prose into a card, nor carry a line out of one the author wrote.

**Why that is still safe, and in three ways stronger than what it replaced.**

- **The judgement runs on the PLAN, not on the incoming forest.** A plan sees a
  retyped survivor, a moved row and a deletion as themselves; a walk over the
  parsed markdown saw all three as "a node I cannot distinguish from a create".
  So the two invariants that used to live over the forest — *nothing may mint a
  human-audience card*, *notes do not nest* — moved onto the plan and got
  stronger in the move. **Neither survives as a rule of its own, and each went
  for its own reason.** Minting is a write at the new card's own row, so the
  `author` walk refuses it with nothing to keep in step; nesting was refusing a
  shape the rest of the system handles, so it was dropped outright (see **A card
  inside a card** below). What is left is one walk.
- **Both chains, not just the new one.** Re-indenting the page's prose under an
  existing card is a MOVE, and because the aligner preserves the id of
  byte-identical text it arrives as an `update` naming `parentId` — not a create.
  An after-only test would accept it, and the whole page could be annexed into
  the agent's own card, attributed to the agent, without a character being
  deleted. Updated/text-edited blocks are therefore judged on their OLD chain as
  well (`side: "old"`), resolved against pre-plan maps so moving an ancestor
  in the same plan cannot launder a block through it. The same two chains carry
  the closed answer for free: writing INSIDE a `<human>` card fails on the new
  side, carrying a block OUT of one fails on the old.
- **It runs strictly before the first write.** `assertAcceptable` is called
  synchronously after planning and before `applyPageBlockPatch`, so a refusal has
  provably written nothing — and the plan it judged is the one that would have
  been committed, not a second read of the rows.

**Addressing is still the authorization for READS**, and that half did not move:
`assertAgentAddressable` refuses a block that IS, or sits inside, a
human-audience card, and `edit_page` goes through that same door on its way in —
it reads the scope as markdown before it edits it. What changed is only the
verdict on the way out.

### The residual bound is CLOSED: a card the human wrote is a hole in the agent's

> **This section reverses a recorded bound.** It used to read: *an edit whose
> diff stays inside a card may rewrite that card wholesale, including anything a
> HUMAN typed into it.* So there was no way to answer an agent inside its own
> note and have the answer survive the next `write_agent_note`.

Every annotation declares `author` as well as `audience`, and the write rule is
**the nearest declaring ancestor wins**: `writeBoundaryOf()` asks each ROW
`blockAuthorOf(handle, data)` and maps `"agent"` → `"open"`, `"human"` →
`"closed"`, nothing → `undefined`, and the engine's walk stops at the first row
that declares ANYTHING — not the first that says yes. So a `<human>` or `<todo>`
card nested inside an `<agent-inline>` card (or an `<agent-page>`) shields its own
contents, an `<agent-inline>` card a human nested inside a `<human>` card still
admits writes, and prose is refused because nothing on its chain ever declared.
The classifier is handed the row's `data` because one kind of row declares
through it: an agent-authored page (see below). **A declaring row is inside itself**, so
minting a `<human>`, `<todo>` or `<private-note>` anywhere — including inside the
agent's own card — is refused by that same walk, at the new row.

That last point is why one invariant disappeared rather than moved: *nothing may
mint a human-audience card* was a separate walk over the plan's creates and
retypes, and it is now the same walk with the same evidence. Two invariants that
could drift out of step became one that cannot.

`writeBoundaryOf()` is read at CALL time like `humanAudienceTypes()`, and the
**degradation direction inverts**: an empty registry means nothing is open, i.e.
every write is refused — loud, where the same degradation for `audience` would
have meant "redact nothing".

What is left of the bound, narrower: **plain text a human typed LOOSE in a notes
card is still the agent's to rewrite** — it declares nothing, so the nearest
declaration above it is the card's own `author: "agent"`. The affordance, not a
workaround, is to put the answer in a `<human>` card.

### A card inside a card

An `<agent-inline>` card nested in another one used to be refused outright. That rule
came from `append_agent_notes`, where a card id was the append TARGET and nesting
was a caller mistake with no meaning; when that tool died it was carried across
onto the plan rather than reconsidered.

It is gone, because it refused a shape the rest of the system already handles.
The markdown tag scanner counts nested opens of its own name
(`editor/core/markdown.ts`), the editor imposes no child-type restriction — a
human can nest two cards by hand today, and an agent may already nest a `todo` or
`context` card in one — and `ContainerBackdrop` reserves a nesting pad so an inner
card starts one pad below its parent's edge, its wash composing over the outer
one, which is the cue that it IS a separate card. The boundary judgement reads a
nested card as inside a card, because it is one.

Two consequences, stated rather than discovered:

- **`write_agent_note` no longer catches the wrapping mistake.** Its `content` is
  the card's CONTENTS; an agent that wraps it in an `<agent-inline>` tag anyway now
  mints a card inside the card it was writing. The tool's description says that,
  rather than promising an error it no longer raises.
- **Authorship stamps the NEAREST agent-authored row.** A write inside a nested
  card marks that card as this conversation's work; the card holding it is not
  marked — and nor is an agent page holding it.

### Redaction is no longer a read-only concern either

The old rule's corollary was that redaction never had to touch the write path:
strip a private card on read, and a write diffing the edited document against the
FULL stored forest reads every stripped card as a deletion — so the write scope
simply never contained redacted content, because a private card cannot live
inside an agent-note card.

A page-rooted `edit_page` blows that up: the scope now IS the page, so it
contains every private card on it. The answer is not a second filter but the
**same** one, run on both halves: `redactHumanAudience` is `ReadBlockOptions.redact`
and `ApplyBlockOptions.redact`, so a write diffs against exactly the document the
read produced. A card the agent never saw is invisible to the walk and preserved
by it — the engine keeps its `(parent_id, rank)` key reserved, and a `ref` naming
it answers `ref-out-of-scope` rather than `unknown-ref`, so an id copied from
somewhere else cannot drag it into scope. See *Ranks are minimal* and *Asserted
identity: pins* in the engine's doc; the invariant this plugin depends on is that
**one function serves both directions**, generic in its row type precisely so a
second, differently-typed copy cannot drift.

The three rules are stated once, in `server/internal/policy.ts`, one per declared
fact plus the door between them: **`audience`** decides what an agent may SEE
(redaction + `assertAgentAddressable`), `assertAgentAuthored` is
`write_agent_note`'s door, and **`author`** decides what it may WRITE
(`assertAgentAuthoredPlan`). All of them enumerate the family generically off
`Editor.BlockData`, ask each row through `blockAuthorOf`, and never name a type —
the agent-note handle excepted, whose TAG a refusal names as the card to mint — so
a fifth annotation costs this plugin zero edits, and so did the agent-authored
page. Both sets are read at CALL time; see the inverted degradation above.

## `write_page` / `edit_page` came BACK — the other reversal

> **This section reverses a recorded decision.** It used to read: *"Whole-page
> markdown editing shipped with the engine and is deliberately removed: no
> agent-reachable tool writes a page's prose."*

`edit_page` exists again, and it is emphatically **not** the tool that was
removed. The one that went away wrote a page's prose: hand it a document and the
page became that document. The one that came back cannot touch prose at all —
the acceptance predicate above refuses every block it creates, rewrites, moves or
deletes that does not resolve inside a region an agent authors. The scope widened from
"one card's subtree" to "any root"; the WRITE surface did not widen at all. Same
name, and the name is now about where the edit is anchored rather than what it
may author.

`write_page` did **not** come back, and the omission is the design: a
whole-document overwrite has no diff to judge, so the predicate it would have to
pass is one it cannot express. Every write is localized, and the closest thing to
a whole-document write is `write_agent_note`, whose scope is one card by
construction. The noun in `write_agent_note`'s name is also its own first error
message — the primary mistake is passing a page id, and the name pre-empts it.

### `edit_page` hands the engine the document it edited

`edit_page` reads the scope, splices one string, and applies the whole document —
so every block it did not touch still round-trips through markdown → forest, and
any loss in that projection would reach `assertAgentAuthoredPlan` as a write outside
every card. It therefore passes the pre-splice document as
`ApplyBlockOptions.baseline`, and the engine subtracts the writes that document
would produce by itself before the predicate judges anything (the engine's own
[`subtract-noise`](../../../markdown-apply/CLAUDE.md) section). The rule the tool
enforces is unchanged; what changed is that it is now enforced against the
caller's edit rather than against the round trip.

**Indentation is matched up to a uniform shift** (`server/internal/indent-match.ts`).
A read scoped to a block holds what is nested under it, at depth zero, so a
line inside a `<todo>` card reads `    * text` in the page's read and
`  * text` in the card's. With no exact match,
`old_string` is retried with every line shifted by one leading-whitespace
prefix and `new_string` shifted with it; the indentation BETWEEN lines stays
exact, because it decides nesting. The result says `reindented`, and a match at
two depths is still non-unique.

`write_agent_note` composes its document rather than editing one, so it passes no
baseline — there is nothing to subtract, and its apply is rooted at one card
anyway.

## The `append` trade: `assertAgentAuthoredPlan` is what a creates-only patch was

`append_agent_notes` is deleted. It never went through the planner: it built the
patch directly — one create for the card, one per parsed child, ranked after the
target's last child — and its argument for being safe was structural and, at the
time, unanswerable:

> **Creates-only is structurally incapable of touching anything else**, which a
> diff-based append would need a guard to promise.

That is exactly the trade this rework made, and it is recorded here rather than
deleted with the file. The guard now exists — `assertAgentAuthoredPlan` — so the
promise is made by a predicate over a plan instead of by the shape of a patch.
What was bought:

- **One dialect, one path.** Append parsed with the engine's own
  `serverMarkdownContext()` but planned with nothing, so "what an agent writes"
  and "what an agent reads back" agreed only for as long as two code paths
  agreed. A tagless `<agent-inline>` in an ordinary `edit_page` document is now how
  a card is minted, through the same planner as every other write.
- **The `blockId`-vs-`noteId` split dissolves.** Three tools, one parameter name
  (`block_id`), because there is no longer a tool whose id means "the parent to
  append under" as opposed to "the thing to write".
- **Creation is judged, not privileged.** A creates-only patch could mint a card
  anywhere, including inside a `/private` one; the plan-level rules refuse that
  (and a minted `private-note`) uniformly, wherever the create came from.

What was paid: the promise is now a predicate, and a predicate can have a bug
where a shape cannot. That is why the acceptance rules are stated once, tested
directly (`server/internal/policy.test.ts`), and asserted end-to-end against the
five-column row snapshot in `e2e/agent-access-verify.ts` — the tool's own report
is not proof that a refusal wrote nothing.

Concurrency changed shape with it: two appends from the same floor collided at
the `(parent_id, rank)` unique index. Two concurrent `edit_page`s cannot — each
plans its ranks against the forest it read under the page lock — but they can
lose an update, the second simply not seeing the first's card.

## Authorship is stamped per agent-authored row, after the commit

An edit may mint and revise several cards and pages, so `assertAgentAuthoredPlan`
returns **the set of agent-authored rows** it resolved — each touched block's
NEAREST row whose author is the agent, walked over a forest that includes the page
row — and the tool layer stamps each one. So a write anywhere inside an agent page
stamps the page, and a page the edit MINTED is its own nearest row: it is stamped
as its own creator. The creator chip is the EARLIEST stamp, which is also why an
empty agent page a human inserted (`/agent-page`) shows no chip until an agent
writes it, and then names that first writer. Always AFTER the patch commits: `page_blocks_agent_authors.block_id`
FKs onto the card's row, so stamping a card the same call just created is a
foreign-key violation until then. `recordAgentNotesAuthor` is
`onConflictDoNothing`, so re-stamping is free.

`write_agent_note` also stamps its target card when the diff was empty — "I wrote
this card" is true either way. `edit_page` stamps nothing in that case: it names
no card of its own, so an edit that touched none has no authorship to claim. The
tool layer is the only place a `conversationId` exists at all; neither the engine
nor the policy ever learns one.

## Agent-authored pages: `<agent-page>` next to `<agent-inline>`

An agent writes to a page through one of TWO kinds of block
(`research/2026-09-11-page-agent-pages.md`):

- **`<agent-inline>`** — the card, placed among the page's own blocks. Its tag was
  `<agent-note>`; only the tag was renamed (the stored type stays `agent-note`,
  nothing migrated), and `write_agent_note` keeps its name.
- **`<agent-page>`** — a real sub-page whose whole content is the agent's. Not a
  new block type: a `type="page"` row whose `data.author === "agent"`, so every
  site that knows what a page is (sidebar, trash, history, search, backlinks, the
  expand-inline mount) needed no change. The page declares its own author from
  that field (`pageBlockAuthor.authorFromData`), which is the ONE thing this
  policy reads — through `blockAuthorOf`, like every other row.

```
edit_page(parent)   <agent-page title="Findings">…body…</agent-page>   ← tagless: mints the page
read_page(parent)   <agent-page id="block-…" title="Findings"/>          ← afterwards: a pointer
read_page / edit_page / write_agent_note (block_id = the page)          ← its whole content
```

- **A read rooted at the page says it is one.** The page's own row has no tag in
  a page-rooted read, so `<page-meta kind="agent-page">` is the agent's only
  signal that the prose in front of it is writable. Without it an agent took an
  agent page's prose for the human's, and its "page-editing check" looked broken
  when the check was right.
- **A page's content is written by its own id.** The pointer never carries a body:
  one with a body, or with any attribute but `title`, is refused (a planner
  `ref-out-of-scope`, and a parse error for the attribute). The result's
  `created_page_ids` names a minted page so the agent can tell it from its body.
- **The pointer's `title` is read-only**, shown so an agent can tell pages apart.
  It is ignored on a pointer (the planner compares only the spelling), so a title
  gone stale since the read costs nothing. A human's sub-page and a link now show
  `<page id="…" title="…"/>` too — an annotated attribute supplied by
  `editor/server` and `page-link/server`.
- **An agent renames its page by editing the `# Title` line in `edit_page`** —
  see *Renaming an agent page* below. The pointer's `title` stays read-only.
  `write_agent_note` on a page strips an echoed banner (byte-identity, as for
  every page-rooted apply); any other `# …` line in its content is an ordinary
  heading.
- **Nothing an agent does makes it one or unmakes it.** `<agent-page id="H"/>`
  naming a human's page is `unknown-ref` (the planner's canonical-spelling check),
  a pointer at an agent page cannot be turned into a link, and the server refuses
  any data write that flips the marker (`rewriteBlockData`, 409). The one thing
  that flips it is the human's kind control in the page header (`setPageKind`), which
  no MCP tool exposes. An agent page is never deleted by an apply — leaving it
  out of a document re-homes it, the sub-page rule.

### Renaming an agent page

`read_page` on a page opens with its title as `# Title` and a blank line — the
banner, a line the reader adds on top, never a block
([`markdown-apply/core/page-title.ts`](../../../markdown-apply/core/page-title.ts)).
On an AGENT-authored page, `edit_page` changing that line renames the page:

1. **Only a page-rooted edit that changed the banner is looked at** — the case
   that used to be a flat 400. The page's author is asked through `blockAuthorOf`
   off `scope.pageRow`. A human's page keeps the 400.
2. **The edited document's first non-empty line must be the whole title** —
   `parsePageTitleBanner`: one `# ` line of plain text (no marks, links or
   colors), spelled exactly as `read_page` would spell that title, and followed
   by a blank line or the end of the document. Anything else (the line deleted,
   run into the next block, or formatted) is the 400, with a hint: change only
   the text after `# `, and keep it one `# ` line followed by a blank line.
3. **That line must be the ONLY thing the edit changed.** With the stored banner
   put back, the document must be byte-identical to the read. So the content
   apply plans nothing, and the title never reaches the planner — where a changed
   one would be a created heading, which inside an agent page is a writable one.
   A rename plus a content change is two calls. This is also what keeps a deleted
   banner from reading as a rename: on a page whose first block is an H1, the
   document without its banner is byte-for-byte "rename to that heading and
   delete it", and only the rest of the document staying put tells them apart.
4. **Then `renamePage(pageId, title, { requireAuthor: "agent" })`** writes the
   page ROW's data (editor/server) — the call's only write. The author check
   runs again there, under the lock, because a human can flip the page between
   step 1 and this write.
5. The page is stamped with the conversation, and the result carries
   `renamed_to`.

**Why `edit_page` only.** `write_agent_note` composes the page's whole contents,
so a `# …` line at its top that is not byte-identical to the banner cannot be
told apart from a first heading the agent wants on the page. It stays a heading
there, and the tool's description points to `edit_page` for renames. `edit_page`
has the document the agent edited in hand, so "the banner line changed" is a
fact, not a guess.
- **No agent-origin marker.** `apps/pages/agent-origin` also says "agent pages" —
  for e2e debris its 24h sweep trashes. An MCP apply writes through
  `applyPageBlockPatch`, which never fires `BlockLifecycle.AfterCreate`, so an
  agent-authored page is never marked. Keep it that way: no synthesized `Request`,
  no header.

### The enclosure: what the scope root sits inside

The engine's walk stops at the apply's ROOT, so a root that declares nothing used
to end every chain in "outside every card". `boundaryViolations` now takes a
required `enclosure`: the policy's `enclosureOf` walks from the root's parent up
through the partition, then the page row — never into the parent page — and hands
in the nearest declaration it meets. For a PAGE root it is the page row's own
declaration, which is how an agent page is open all the way down.

**The stated behaviour change:** an apply rooted at a nested block INSIDE an
`<agent-inline>` card was refused, and is accepted now. Rooted inside a `<human>`
card it stays refused, now as `enclosed`, naming the card. The page row comes from
the same read as the plan (`BlockScope.pageRow`, handed to `assertAcceptable` as
`{ rows, pageRow }`), so the enclosure is judged against the page the plan was
built over.

### The door

`assertAgentAuthored` (was `assertNoteCard`) admits a live row whose author is the
agent — an `<agent-inline>` card, or an agent page by its own id — asked through
`blockAuthorOf`, never by type. Its refusal, like every refusal here, spells the
tags off the handles (`markdownTagNamesAuthoredBy`, `markdownTagNameOf`): the
document says `<agent-inline>` while the column says `agent-note`, and a literal
would drift the day either moves.

## Instructions are delivered before a write is allowed

A page's author can leave instructions for agents: an `<instructions>` card, or an
instructions page ([`instructions`](../instructions/CLAUDE.md) owns which ones
cover a page and which a conversation has received). This plugin decides how an
agent gets them, in `server/internal/instructions-gate.ts`:

- **`read_page`** puts every covering instructions block the conversation has not
  received (or that changed since) in a `<received-instructions>` block ahead of
  the page, then records them as received. A block the read already shows whole
  is left out of that block but still recorded: a card counts when the body holds
  its id AND its whole rendered content, and a card or page counts when the read
  is rooted at it.
- **`edit_page` and `write_agent_note`** check the same thing right after their
  door checks and before anything is matched or planned. If anything is
  undelivered, they refuse with a 409 whose message carries the instructions in
  full, and record them as received, so the retry goes through. A refusal
  therefore writes nothing.
- **At conversation start**, `Mcp.instructions({ id: "page-instructions" })` adds a
  section to the MCP server instructions: a fixed paragraph saying all of the
  above, then every GLOBAL card in full (recorded as received) and every global
  page as a pointer. It never returns `null`: the paragraph is useful even with no
  global instructions, because scoped instructions still refuse writes. Each
  render logs its length to the `mcp-page-instructions` channel, since a client
  may truncate long server instructions.
- **After a compaction**, the instructions a read or a refusal handed over are
  gone from the agent's context while their deliveries still say "received".
  `restoreAfterCompaction` — this plugin's `CompactionContext` contribution
  ([`conversations/compaction-context`](../../../../../conversations/plugins/compaction-context/CLAUDE.md),
  whose SessionStart(compact) hook calls it) — forgets them, then re-renders
  every one still live at its current version, records it as received again and
  returns it in a `<received-instructions>` block the hook injects. One
  transaction. Global cards are skipped: they ride the MCP server instructions,
  part of the system prompt, which a compaction keeps. A restored block carries
  no `covers-*`: an instructions page reached through a link covered the link's
  page, which only that read knew.

The section lives here rather than in `instructions` because it describes these
three tools by name; `instructions` stays free of MCP, and the import stays one
way (agent-access → instructions).

## Tags: the header's one writable section (`server/internal/page-tags.ts`)

A page's tags (`page/tags`) are its status and labels, drawn from one shared
vocabulary. `read_page` states them first in the `<page-meta>` header
(`<tags>` / `<tag name="…"/>`, `<tags/>` when none), and `edit_page` writes them:

- **A change is the edited header's tag list differing from the read's** —
  ordered names compared by key (`tagKey`), a `new` or `color` attribute counting
  as a change. An edited header with no `<tags>` section, or no header, asks for
  no change. Every OTHER header field stays read-only, and `page_meta_ignored`
  fires only when one of those changed (`metaFactsChanged`).
- **Resolved before anything is written.** `resolveTagNames` matches names case-
  and whitespace-insensitively, collapses duplicates, and refuses an unknown name
  that is not marked `new="true"` — 400 listing each with its closest names and
  the whole vocabulary, nothing written, content included. That is the typo and
  synonym guard: growing the vocabulary is one deliberate attribute.
- **Written after the content apply** (`writeResolvedPageTags`: create the `new`
  ones, then set the list, one transaction), on the page holding the scope root
  — ANY page, the human's included: tags are metadata, not the author's prose,
  so the authorship walk does not apply to them. The result carries `tags_set`
  and, when any were made, `tags_created`.
- **An old_string opening with this read's own header, byte for byte, is matched
  as written** (header kept on both sides), so pasting the whole header to edit
  its tags works; a header from another read is still dropped before matching.
- **Status is a tag, never a `[…]` title prefix**: an agent-page rename to a
  title opening with `[Something]` is refused with that pointer
  (`BRACKET_STATUS_PREFIX`). `write_agent_note` does not touch tags.

## Stated bounds

- **Absence is visible.** A read shows a gap where a private card was — no
  marker, by choice — so an agent may re-derive something the author already
  noted privately. `read_page`'s description says so, which is the mitigation.
- **Plain text a human typed loose in a notes card can be overwritten** by the
  next `write_agent_note` — it declares no `author`, so the nearest declaration
  is the card's own. A `<human>` card nested there cannot be: that is the
  affordance to point them at, not `edit_page`. `write_agent_note` composes the
  card's WHOLE contents, so omitting such a card plans its deletion and the whole
  write is refused with nothing written; its description says to echo it back.
- **A card is minted where the tagless tag sits, not where a hidden row does.**
  Blocks inserted where a redacted row sits land AFTER it, contiguously — the
  engine's rank rule (`planSiblingRanks`' `reserved`), inherited here because
  this plugin is what makes the write redact in the first place.
- `read_page` loads the scope twice (once to decide about the id, once inside the
  engine to serialize it). Deliberate: the policy question must be answered
  before the id is handed over as a root. The WRITE path no longer double-reads —
  one `BlockScope` is loaded, serialized for the agent and diffed against, which
  is what makes "a write diffs against the document the agent saw" literally
  true rather than probably true.
- **The `# Title` banner is writable only as an agent page's rename, and only
  through `edit_page`.** On a human's page, `edit_page` refuses an edit that
  changes the document's first line with a message naming the title rather than
  letting it fall through to the planner as a created heading — diagnosis, not
  authority, since the planner would refuse the heading anyway. On an agent page
  the edit is a rename (see *Renaming an agent page*): the title is written to
  the page row's `data`, and the banner is still never a block. `write_agent_note`
  cannot rename, because there a new `# …` line is indistinguishable from a first
  heading.
- **A rename is an edit of the title line alone.** An `edit_page` that changes
  the title AND the content is refused (the 400 above); the agent makes them two
  calls. The price is one extra call, and what it buys is that a deleted banner
  is never mistaken for a rename, and a rename is never half of an edit.
- **Sending the same minting document twice creates two pages** — the same as a
  tagless `<agent-inline>` today. A mint has no identity to converge on.
- **A crash between the commit and the authorship stamp** leaves an agent page
  with no creator chip. Nothing is corrupted; the next write stamps it.

Design: [`research/2026-08-07-page-agent-note-file-like-tools.md`](../../../../../../research/2026-08-07-page-agent-note-file-like-tools.md)
(supersedes [`research/2026-08-05-page-agent-notes-mcp-access.md`](../../../../../../research/2026-08-05-page-agent-notes-mcp-access.md),
which is where the two reversed decisions were made).
Spec: `e2e/agent-access-verify.ts`.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The agent-facing tool surface over a page, as the file triple: read_page (human-audience subtrees pruned), write_agent_note (one agent-authored block's whole contents — an <agent-inline> card, or an <agent-page> by its own id) and edit_page (any block, judged by what the diff touched — every write must resolve inside a region an agent authors, so an <agent-inline> card or an <agent-page> admits it and a <human> or <todo> card nested there refuses it; a tagless <agent-page title> mints a sub-page). The policy over page/markdown-apply's audience-and-author-agnostic engine.
- Server:
  - Contributes: `conversations.compaction-context` "page-instructions"
  - Uses: 28 symbols — full list in [REFERENCE.md](./REFERENCE.md)
    - `page/annotations/instructions` ×9
    - `page/markdown-apply` ×5
    - `page/editor` ×3
    - `page/tags` ×3
    - `database` ×2
    - `conversations/compaction-context.CompactionContext`
    - `infra/endpoints.HttpError`
    - `infra/mcp.Mcp`
    - `page/annotations/agent-notes/authorship.recordAgentNotesAuthor`
    - `page/annotations.humanAudienceTypes`
    - `primitives/log-channels.defineLogSink`
  - Register:
    - `mcpTool('read_page')`
    - `mcpTool('write_agent_note')`
    - `mcpTool('edit_page')`
    - `mcpInstructions('page-instructions')`

<!-- AUTOGENERATED:END -->
