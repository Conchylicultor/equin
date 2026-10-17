# annotations

The page's **side-channel between a human and the agents working on it**, as
block types. An annotation is a [void container](../container/CLAUDE.md) — it owns
no text; its content IS its children — whose soft tint says *this run of blocks
is not the page's prose, it is addressed to (or withheld from) an agent*.

Five of them, and the family is a two-axis matrix rather than a list: each card
declares who may RECEIVE it (`audience`) and whose words it holds (`author`),
and the second answer is also who may WRITE it.

| Block | `audience` | `author` | Means |
|---|---|---|---|
| `/human` | `agent` | `human` | The page author's own words for an agent: conventions, glossary, "always run X first", or a correction typed into an agent's own note. Aliases `/context`, `/user`. |
| `/todo` | `agent` | `human` | Work an agent still has to do. Also minted by typing `TODO ` at the start of a line. |
| `/instructions` | `agent` | `human` | Standing instructions for every agent working under this page, like a `CLAUDE.md` for a folder. Delivered to an agent automatically (see below). Aliases `/rules`, `/guidance`, `/conventions`. |
| `/agent` | `agent` | **`agent`** | Notes an agent wrote back: what it found, what it assumed, what it left. |
| `/private` | `human` | `human` | Withheld from agents. The one block whose contents an agent must never receive. |

**`/agent` is the only agent-authored CARD in the system** — its markdown tag is
`<agent-inline>` (the stored type stays `agent-note`). The only other thing an
agent authors is an **agent-authored page** (`<agent-page>`), and it is not a card
of this family: it is an ordinary `type="page"` row whose `data.author ===
"agent"` (`research/2026-09-11-page-agent-pages.md`).

So the agent-write rule still reduces to one question, asked per ROW: *whose
words does this row hold?* There is no list of writable types anywhere. An
annotation answers from its handle (`author`, declared through
`defineAnnotationBlock`); a page answers from its own data (`authorFromData`, on
the shared page declaration); every other row answers nothing. Consumers read the
answer through the one resolver, `blockAuthorOf(handle, data)` (`page/editor`
core), never off `handle.author` directly — a consumer that did would read an
agent-authored page as the human's.

They are siblings under one umbrella rather than five entries in the flat
`page/plugins/` list because a consumer of this family always wants the SET — the
delivery step below has to ask "which annotations does this page carry, and who
is each one for?", never "is there a human card?".

## Both parties are declared, and one consumer reads each

**Declared.** `core/define-annotation-block.ts` — `defineAnnotationBlock` is
`defineContainerBlock` plus two REQUIRED fields, `audience` and `author`, landing
on `BlockHandle`. They are genuinely separate questions: `/human` and `/todo` are
addressed to an agent and are still not an agent's to rewrite.

- **They ride the handle**, already what `Editor.BlockData.getContributions()`
  gives the server — so both consumers read the registry they already read, with
  no second registry to drift. Both filter generically (`audience === "human"`,
  `blockAuthorOf(handle, data) === "agent"`), never by type name, so a fifth
  annotation costs the delivery and write paths zero edits — and the
  agent-authored page cost them none either.
- **Unmarked is unrepresentable here, not defaulted.** Outside this family the
  absent values are what an ordinary paragraph means, and they point in opposite
  directions — absent `audience` is *visible to everyone* (a paragraph is
  withheld from nobody), absent `author` is *the human's* (the page's prose is
  not an agent's to rewrite). Both are the fail-safe reading of their own axis,
  which is why an annotation must state them rather than fall through.
- **`./singularity check annotations:parties-declared`** fails a block type under
  this umbrella that reached for `defineContainerBlock` directly, which would
  make it an ordinary paragraph on both axes — agent-visible and, worse for a
  card an agent is meant to own, silently unwritable. Presence of the fields is
  the discriminator; nothing else can set them.

**Read** by exactly one consumer:
[`plugins/agent-access`](plugins/agent-access/CLAUDE.md), which prunes `human`
subtrees out of the agent-facing `read_page` — and out of the WRITE's walk
through the same filter — and confines every write to a region an agent authors.
That confinement is judged on the PLAN a write produces, not on which id opened
it: `edit_page` accepts any block, including the page itself.
`/private` is a real channel there and nowhere else — a `/prompt` launch still
sends only that block's own text, and no other surface filters.

### The write rule: the nearest declaring ancestor wins

For every block a write touches, the walk goes up from the block itself and stops
at the **first row that declares an `author` at all** — not at the first row that
says yes. So:

- inside an `<agent-inline>` card: writable, because the nearest declaration is
  `author: "agent"`;
- anywhere inside an `<agent-page>`: writable, because the nearest declaration is
  the page's own row (its data says `author: "agent"`). A write rooted at the
  page's own id hears that through the scope's ENCLOSURE — what the root sits
  inside — which is how every block of the page is the agent's. That marker is
  set when the page is born and changed afterwards only by the human's header
  kind control (`setPageKind`, whose write is `rekindPageData`) — never by a data
  edit, and never by a history restore, which keeps the page's current kind;
- inside a `<human>` or `<todo>` card **nested in either**: refused. The nested
  card declares `human` first, and it is a hole in the agent's own region. This
  is what makes answering an agent inside its own note survive the next
  `write_agent_note`;
- anywhere else on the page: refused, because nothing declares and absent means
  the human's. The page's own prose is read-only to an agent for exactly that
  reason — not because a rule enumerates prose, but because prose declares
  nothing, and neither does a human's page.

Minting counts as writing at the new card's own row, so an agent cannot create a
`<human>`, `<todo>` or `<private-note>` anywhere, including inside its own card or
page. It CAN mint an `<agent-page>` wherever it could mint an `<agent-inline>`
card: the new page's row declares `agent` from its own data. Filing work is
`add_task`.

### Instructions: who receives them, and when

`/instructions` is a card, but it is also a page kind: a page whose data says
`instructions: true` is an instructions page (`<instructions-page>`). Both are the
human's words, so the write rule above already keeps agents out of them. What is
new is that they are **delivered**, not just readable. See
[`plugins/instructions`](plugins/instructions/CLAUDE.md).

- **Scope.** A card covers the page it sits on and every page below it. An
  instructions page covers its PARENT page and every page below it, itself
  included, the way a `CLAUDE.md` covers the folder it sits in. A card or page
  inside a `/private` card covers nothing.
- **On a read.** `read_page` opens with a `<received-instructions>` block holding
  every covering instructions block this conversation has not received yet, or
  whose content changed since it did. A block the read already shows in full is
  not repeated.
- **On a write.** `edit_page` and `write_agent_note` refuse (409, nothing written)
  while any covering instructions are undelivered, and the refusal carries them.
  The refusal counts as the delivery, so the retry goes through.
- **At conversation start.** Instructions marked global go into the MCP server
  instructions: cards in full, pages as a pointer to read.
- **After a compaction.** Everything a read or a refusal had handed over is
  handed back by the SessionStart(compact) hook, at its current version — the
  summary would otherwise drop it while the record still said "received".

Delivery is recorded per conversation at a hash of the rendered markdown, so
editing the instructions makes every conversation receive them again.

**The markdown serializer keeps emitting private children**, deliberately: it
runs for the CLIPBOARD, and a human copying their own page must get their own
notes. Redaction is the agent-facing consumer's job, never a serializer's, which
would silently eat text on Cmd+C.

## What every annotation shares, and what stays per-block

Shared, and NOT re-derived per plugin: the whole void-container shape —
`anchor` / `wrapOnConvert` forced, plus `ContainerNoRow`, `ContainerBackdrop` and
`ContainerCornerLabel`. The mechanism lives in
[`page/container`](../container/CLAUDE.md); an annotation plugin adds none of its
own. It reaches it through this umbrella's `defineAnnotationBlock`, never
`defineContainerBlock` directly — that is the two declarations above, and the
check enforces it.

**No annotation has per-instance appearance.** Every payload is `z.object({})`
except `/instructions`, whose one field, `global`, is the card's reach rather than
its look. Keep it that way: a field that changes how a card looks does not belong
in its data. The structural actions (Collapse / Remove `<label>` / Delete)
are never contributed either: they come from the rail on the line the card
BORROWS, whose menu arm keys on the core `BlockHandle.anchor` fact.

Two of the five still put something behind their NAME, and neither breaks that
rule, because what they show is per-instance STATE held in a side-table keyed on
the block id — not per-instance *data*:

- **`agent-note`** passes `sections`: the card's PROVENANCE, which conversations
  wrote into it. See
  [`agent-notes/plugins/authorship`](plugins/agent-notes/plugins/authorship/CLAUDE.md)
  — the same record an agent-authored page's creator chip reads. With no authors
  it falls back to the plain inert mark.
- **`todo`** passes `sections` AND a `BlockFrameMeta.menu` — the same dispatch
  panel in both places, per the container convention. It is the one annotation
  with an ACTION rather than a read, so its name is a trigger even before there
  is state behind it, and the one that declares an `action`: point at the word
  `TODO` and it becomes `▷ LAUNCH`, in place. It is also the only container in
  the repo with a `BlockFrameMeta.foot` — the runs it has launched, as chips at
  the bottom of its box. See
  [`todo/plugins/task-link`](plugins/todo/plugins/task-link/CLAUDE.md).

`instructions` passes its name (`Instructions`, or `Global instructions`) and a
`BlockFrameMeta.menu` holding one switch, **Global**, which writes the card's one
data field.

`human` and `private-note` pass a bare name — plain and non-interactive on both
surfaces.

Per-block, and deliberately: its identity (`type`, label, aliases), its
tint, and its markdown marker. Those are five separate `Editor.Block` /
`Editor.BlockFrame` registrations rather than one parameterized helper, for the
reason `page/container` already records — containerhood is derived from *who
actually paints a box*, so a registration made on a plugin's behalf would move
that fact one indirection away from the plugin it describes.

A block's stored `type` is not always its spelling: `human-notes` stores
`context` and tags `<human>`, `agent-notes` stores the singular `agent-note` and
tags `<agent-inline>` (renamed when `<agent-page>` arrived — only the tag moved).
`BlockTag.name` exists so a tag may differ from a type, and a type is what page
rows and the `Editor.Block` contribution id (hence users' persisted reorder
directives) are keyed by — so renaming a card is a rename of everything except
that. Each block file argues its own case.

### The family is NAMED, where a callout is DRAWN

That sentence replaced the old family signature, which was a **dashed border**.
Dashes, a permanent icon in the margin and a hue were three marks doing one job,
and a page carrying three cards read as a stack of widgets rather than as a
document with asides. What is left is:

- a **soft tint and nothing else** at rest — no border, no icon;
- the card's **own name**, in the box's top-right corner, appearing only while
  the pointer is inside it (`cornerAnchor`, the corner decoration seat — see
  [`page/container`](../container/CLAUDE.md));
- and, for `/todo`, that name doubling as the launch control.

A **callout** is the inverse and that is now the whole distinction: it keeps a
gutter glyph (`anchor`), because its icon is one its author CHOSE and is part of
what the card says, and it carries no name because the icon already answers.
An annotation has no mark of its own to show, so it says what it is in words,
and only when asked.

The icons did not disappear — `MdPerson`, `MdPendingActions`, `MdAutoAwesome` and
`MdVisibilityOff` still name their cards in the slash menu and the turn-into
list, off the handle. They just left the card, where they were charging every
instance a fixed price for a fact the tint already carries.

Within the family the hue carries the direction, over the shared semantic tokens
(never raw colors, so a preset switch restyles them for free):

- `human` — neutral `muted`: the page's own voice, the background against which
  the agent works. Neutral because every other semantic hue here carries a
  status, and this card has none; it also has to stay legible nested inside
  `agent-note`'s `info`, which the write rule makes an ordinary arrangement.
- `agent-note` — `info`: something an agent is telling you.
- `todo` — `warning`: outstanding work. The one hue that is not fixed: a card
  whose dispatched task is `done` repaints `success` and a `dropped` one fades to
  `muted`, so a finished TODO stops shouting without leaving the page.
- `private-note` — `destructive` at low alpha: restricted, not an error. The
  NAME carries the meaning; the tint only flags it. It is the one card whose name
  genuinely tells the reader something the hue cannot, which is the argument for
  a word over an icon rather than against showing anything at all.

The alphas lifted a step when the borders went: with no edge to hold it together
a `/5` wash read as a smudge rather than as a box.

**No card keeps its name at rest**, `/todo` included. It used to: a dispatched
card stopped hiding and spelled the task's live status there, because the tint
cannot — an open card and one being worked on are both `warning`. `/todo` now has
a FOOT for that (`BlockFrameMeta.foot`, see
[`todo`](plugins/todo/CLAUDE.md)), so the name is back to being worth nothing at
rest. Don't reinstate it: two renderings of one status drift.

<!-- AUTOGENERATED:BEGIN — do not edit; regenerated by `./singularity build` -->

## Plugin reference

- Description: The annotation family's server-side reading of its audience axis: humanAudienceTypes(), the block types withheld from agents, read off the Editor.BlockData registry at call time.
- Server:
  - Uses: `page/editor.Editor`
  - Exports (values): `humanAudienceTypes`
- Core:
  - Uses:
    - `page/container.ContainerBlockOptions`
    - `page/container.defineContainerBlock`
    - `page/container.RejectTextBearing`
  - Exports (types):
    - `AnnotationBlockHandle`
    - `AnnotationBlockOptions`
  - Exports (values): `defineAnnotationBlock`
- Cross-plugin:
  - Imported by:
    - `page/annotations/agent-access`
    - `page/annotations/agent-notes`
    - `page/annotations/human-notes`
    - `page/annotations/instructions`
    - `page/annotations/private-notes`
    - `page/annotations/todo`
- Sub-plugins:
  - **`agent-access`** — The agent-facing tool surface over a page, as the file triple: read_page (human-audience subtrees pruned), write_agent_note (one agent-authored block's whole contents — an <agent-inline> card, or an…
  - **`agent-notes`** — Agent-notes block type: a void CONTAINER whose soft-tinted box wraps blocks of any type nested inside it, holding what an agent wrote back to the page's author. Agent-notes block type: registers its…
  - **`human-notes`** — Human block type: a void CONTAINER whose soft-tinted box wraps blocks of any type nested inside it, holding the page author's own words addressed to agents rather than to the reader — and, being the…
  - **`instructions`** — Instructions block type: a void CONTAINER whose soft-tinted box wraps blocks of any type, holding the human's standing instructions to agents working under the page it sits on — delivered to them…
  - **`private-notes`** — Private-note block type: a void CONTAINER whose soft-tinted box wraps blocks of any type nested inside it, holding notes withheld from agents. Private-note block type: registers its (empty) `data`…
  - **`todo`** — TODO block type: a void CONTAINER whose soft-tinted box wraps blocks of any type nested inside it, marking a region of work agents still have to do. Also minted by typing `TODO ` at the start of a…

<!-- AUTOGENERATED:END -->
