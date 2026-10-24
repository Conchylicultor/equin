# Page agent-notes → file-like Read / Write / Edit

## Context

An agent asked to annotate a specific line of a page today cannot do it through the
page tools. `read_page` returns the content but **withholds every block id**, so the
only anchor reachable through the API is the page root itself. Getting a line's id
means dropping to `query_db` — a documented *debugging* tool — as a workflow
dependency. The write tools accept any block as an anchor; the read tool hands back
nothing to use as one.

The file tools do not have this problem, because a path is an address that exists
before you read the file. `Read`+`Edit` compose; `read_page`+`edit_agent_notes` do
not. The owner's model (page `block-1786031061946-hx4np5`) closes that by making the
page surface mirror the file triple:

| Files | Pages today | Pages after |
|---|---|---|
| `Read` | `read_page` | `read_page` — emits `# Title` and `<agent-note id="…">` |
| `Write` | `write_agent_notes` | `write_agent_note` — one card, unchanged scope |
| `Edit` | `edit_agent_notes` | `edit_page` — **any** id, judged by what the diff touched |
| — | `append_agent_notes` | **deleted** — a tagless `<agent-note>` creates the card |

Outcome: an agent reads a page, sees ids on exactly the things it may write to, and
annotates any line with the same Edit contract it already knows from files.

## Decisions (owner)

1. **Acceptance predicate.** Every changed block must be inside an existing
   `agent-note` subtree, or part of a newly created one. Everything else refused.
2. **Redaction: invisible but preserved.** The planner diffs against the same
   redacted row set the read produced, so a `/private` card can never be seen as a
   deletion.
3. **`<agent-note>` singular**, tag + DB type. Directory, package names, exported
   symbols and the `agent-notes-authors` resource id **stay plural** — a directory
   names a feature area, not an instance, and renaming them is all cost.
4. Ids appear on `<agent-note>` and `<page/>` only. Deletion is out of scope.

## This reverses two recorded decisions — say so, don't drift

`agent-access/CLAUDE.md` records **"Addressing is the authorization — writes are not
restricted by validating the patch they produce"**, and **"`write_page`/`edit_page`
are gone"**. The new `edit_page` takes a page id and validates the patch. Both
sections must be rewritten to state the reversal and why it is still safe, or the
next reader restores the old rule.

---

## Four traps that must be designed for, not discovered

**T1 — Rank collision. Highest severity; fires on the most likely edit.**
Page children `A / P(private) / B`. The agent sees `A B` and inserts a card between
them. `planSiblingRanks` mints `Rank.nBetween(rankA, rankB)` — the deterministic
midpoint, which **is** `rankP` whenever P was itself inserted between A and B.
Violates `page_blocks_parent_rank_live_uq`; the whole apply 500s. Latent today only
because writes never redact. Fix: `planSiblingRanks(existing, reserved)` treats each
hidden rank inside a mover run as an extra fixed point, and mints the whole run into
the interval above the last of them. Stated bound, unconditional: *blocks inserted
where a hidden row sits land after it, contiguously.* Contiguity is the deliberate
choice over interleaving — a hidden row keeps its position relative to the visible
survivors either way, so splitting a sequence the agent authored as a unit (and
wedging the human's private card inside it) buys nothing.

**T2 — The id attribute is silently stripped.** `z.object({})` drops the unknown
`id` key before the planner sees it, so the tag is decorative and a tagless card can
steal an existing card's row id via LCS ambiguity — detaching its authorship. Fix:
lift `id` out of the attributes onto a **sibling field named `ref`, never `id`** —
`withMintedIds` is shared with clipboard paste, and a future `...node` spread on a
field called `id` would make paste duplicate a live row id.

**T3 — The predicate as stated permits stealing prose.** A block may not cross into a
card it was not already in. Re-indenting the page's prose under a tag is a *move*,
not a creation — and because the text is byte-identical the aligner matches it and
**preserves its id**, so it arrives as an update, not a delete+create:

```
The parser handles UTF-8.          ← block-p1, child of page
<agent-note id="block-card">         ⇒  <agent-note id="block-card">
  Checked the writer.                      The parser handles UTF-8.
</agent-note>                              Checked the writer.
                                         </agent-note>

plan: update{ id: block-p1, changes: { parentId: block-card } }
```

`block-p1`'s *new* chain reaches an agent-note, so an after-only test accepts it. The
whole page can be annexed into the agent's dashed box — attributed to the agent, page
body empty — without deleting a character. Fix: check the chain on whichever sides
exist. **Updated / text-edited → both old and new** (this is the case that catches
it); created → new only (there is no before); deleted → old only (there is no after).

**T4 — Rank-only updates to prose are legitimate.** Minting a card re-ranks its
prose siblings, so `updates` will name prose rows in the normal case. The predicate
must be **field-level**: a prose row may take a rank-only update; `type`, `data`,
`parentId`, any `deleteIds` or `textEdits` entry must resolve inside a card. This
carve-out is where a bug will live — test it directly.

---

## Phase 1 — Engine (`page/editor/core`, `page/markdown-apply`)

Audience-agnostic throughout. The engine takes a root, a row filter, and now a
boundary predicate; it still never learns what an audience is.

1. **`BlockTag.identified` + `SerializedBlock.ref`** — `editor/core/markdown.ts`,
   `serialized-block.ts`. Serialize emits `id` from `ctx.id` (omitted when the forest
   is id-less, so clipboard markdown stays portable); parse lifts it to `ref`. Throw
   at `resolveTag` if a handle declares `identified` *and* has `id` in its schema.
   Do **not** copy `page`'s `serializeOnly` + separate-parse-claimer trick — a parse
   must be able to mint a card, and there is no second "pointer at a note" type.
2. **Pins from `ref`** — `markdown-apply/core/plan.ts`, `flatten.ts`. `pinnedShellKey`
   → `pinnedRowKey`. Derive the identified type set from the handle registry, never a
   literal. **`align.ts` needs no code change** — `forcePins` and `comparable` are
   already written against an opaque `pin`; only their sub-page doc comments move.
   New refusals: `unknown-ref`, `ref-out-of-scope` (a card pruned by redaction or on
   another branch — this is what stops a page-rooted Edit dragging one into scope),
   `ref-duplicated`. `unknown-ref` gets **no** "already in this document" hatch —
   that exists for `<page>` only because it doubles as a `page-link`.
3. **`planSiblingRanks(existing, reserved)`** — `ranks.ts`. Land **before** step 4, so
   the fix is in place when redaction breaks the precondition. Both call sites in
   `plan.ts` need obstacle sets, including the preserved-shell floor.
4. **`redact` on the planner** — one line: `documentOrderRows(redact(existing), rootId)`.
   `existing` stays the **whole** partition (ranks and pins need rows the walk cannot
   reach). Type `redactHumanAudience` as `<R extends {type: string}>` so one function
   serves the read and the write.
5. **`core/touched.ts`** — `touchedBlocks(plan)` and `boundaryViolations({plan, existing,
   rootId, isBoundary})`, returning violations rather than throwing (the caller owns
   status and wording). Implements T3's both-chains rule and T4's field granularity.
   Bound the ancestry walk and throw on non-termination, as `chainToPageRoot` does.
6. **`ApplyBlockOptions {redact, assertAcceptable}`** + `applyScopeMarkdown(scope, …)`
   — `apply.ts`. The hook runs after planning, before the first write. One
   `BlockScope` is loaded, serialized for the agent, and diffed against — which makes
   decision 2 literally true rather than probably true, and retires today's
   deliberate double-read.
7. **`core/page-title.ts`** — emit/strip in one module. `BlockScope` gains `title`
   (`serializePageContent` already returns it and throws it away). Prepend only when
   `rootId === pageId`. Strip only when the first non-empty line is **byte-identical**
   to the banner built from the stored title; anything else falls through to the
   planner and is refused as a heading outside every card. The title handling adds
   zero authority of its own.

## Phase 2 — Rename (its own push, with its migration)

Independently valuable and independently verifiable. `type: "agent-notes"` →
`"agent-note"` in `agent-notes-block.ts:29`; keep `"agent-notes"` in `aliases`.
Also rename `private-notes` → `private-note` (0 rows) so the family is a rule, not an
exception — or document why it isn't.

**Migration** — author via `./equin build --custom-migration`, hand-edit, rebuild:
```sql
UPDATE page_blocks SET type='agent-note' WHERE type='agent-notes';
-- entity_versions.snapshot embeds StoredBlock[] verbatim; a restore replays it
-- through parseBlockData, which 400s on an unknown type. Skipping this leaves
-- 4 permanently unrestorable page versions.
UPDATE entity_versions … jsonb_set over snapshot->'blocks' …
```
Idempotent by construction (`WHERE type='agent-notes'`) — required because every
worktree DB is a **fork of main** and applies this independently.

**Code and migration ship in ONE push.** An unknown block type serializes to an
*empty line*, so a renamed row under old code dissolves on read and is deleted by the
next write.

`config/page/editor/page.editor.block.jsonc:45` needs a hand-edit; the build **fails
loudly** on `config:overrides-authored` and tells you. Never hand-edit `.origin.jsonc`.

## Phase 3 — Tools + policy (`agent-access`)

**Names.** `read_page(block_id)`, `write_agent_note(block_id, content)`,
`edit_page(block_id, old_string, new_string, replace_all)`. One parameter name
across all three — the `blockId`-vs-`noteId` split dissolves with `append`. snake_case
to match the file tools *and* this plugin's own already-snake_case results. Not
`write_page`: the noun in the name pre-empts the primary error (passing a page id).
No `offset`/`limit` — a line window can open a tag it never closes; scope with an id.

**Policy.** `humanAudienceTypes` (never memoize — now gates writes too),
`redactHumanAudience`, `chainToPageRoot`, `assertAgentAddressable` survive.
`assertAppendTarget`, `subtreeRows`, `assertForestWritable`, `assertMarkdownWritable`
die; their invariants move onto the plan, where they are **stronger** (the plan sees a
retyped survivor, which a parsed-forest walk sees only as a create). New:
`assertNoteCard` and `assertNotesOnlyPlan`, the latter returning the card set to stamp
— the same walk, one answer.

**Authorship**: an Edit may mint and modify several cards; stamp each after the patch
commits (FK). `recordAgentNotesAuthor` is already `onConflictDoNothing`.

**Every rejection message names the fix**, as today's do. Cover: page id to Write,
non-card id, edit touching prose, minting into a private card, nested tagless tag,
unknown `<agent-note id>`, dropped `<page/>` pointer, unresolvable ancestry,
`old_string` overlapping the title.

**Discoverability**: one bullet in the root `CLAUDE.md` MCP section pointing at
`read_page` of `block-1786031061946-hx4np5`. **No new skill** — the eight existing
skills are development methodology; a third copy of this prose would drift.

---

## Delegation (Opus agents)

Phases are sequential; work *within* a phase parallelises. One Opus agent per bullet,
each in its own worktree where it touches shared files.

| Agent | Scope | Depends on |
|---|---|---|
| **E1** | `identified` + `ref` + collision guard + fuzz | — |
| **E2** | pins from `ref`, three refusals, `align.ts` doc rewrite | E1 |
| **E3** | `planSiblingRanks(existing, reserved)` + midpoint-collision test | — |
| **E4** | `redact` through the planner + obstacle wiring | E3 |
| **E5** | `touched.ts` + `assertAcceptable` + `applyScopeMarkdown` | E2, E4 |
| **E6** | `page-title.ts` + `BlockScope.title` | — |
| **R1** | rename + both migrations + JSONC + test literals | E1–E6 landed |
| **P1** | `policy.ts` rewrite + `policy.test.ts` | R1 |
| **P2** | `mcp-tools.ts` rewrite, delete `append.ts`, descriptions | P1 |
| **D1** | the three CLAUDE.md reversals + root pointer + e2e rewrite | P2 |

E1/E3/E6 start concurrently. Give every agent T1–T4 verbatim — they are the failure
modes, and each was missed by at least one independent planner.

## Verification

```bash
./equin build          # authority: build-status.json status: ok
bun test plugins/page/plugins/editor/core/markdown.test.ts
bun test plugins/page/plugins/markdown-apply/core/plan.test.ts
bun test plugins/page/plugins/annotations/plugins/agent-access/server/internal/policy.test.ts
bun plugins/page/plugins/annotations/plugins/agent-access/e2e/agent-access-verify.ts
./equin check          # migration-applies-clean replays against live main
```

**Fuzz first** — `markdown.test.ts`'s `gens` has `context` but not `agent-notes`,
`private-notes` or `todo`. Add all four there and to `plan.test.ts`'s `fuzzRows`
(which builds real rows with ids, so `identity ⇒ no writes` becomes the strongest
available proof that pinning round-trips). New law: `plan(rows, parse(serialize(
redact(rows))))` deletes nothing.

**The properties, by hand over MCP**, on a page holding 3 paragraphs, a `/private`
card with a child, and an agent-note card:

1. Read is lossless and redacting — output has all 3 lines and `<agent-note id="…">`,
   and contains neither the secret nor the substring `private-note`.
2. **Feed that exact string back as a write** → `{created:0, deleted:0, moved:0,
   text_edited:0}`. One call proves the tag round trip, id-pinning and alignment.
3. **A private card survives a page-scoped edit** — snapshot
   `(id, type, parent_id, rank, data->>'text')` for the page before and after, and
   diff. The tool's report is *not* proof: a deleted card is simply unmentioned, and a
   card re-ranked to the end of the page passes any row-existence check.
4. Tagless tag mints a card; `page_blocks_agent_authors` names the calling conversation.
5. Each refusal message, **plus set-equality of that same 5-column snapshot** — today's
   "no refusal wrote anything" compares `(id, text)` only, and the new failure modes
   are structural.
6. A browser tab open on the page converges (E3).

Existing spec properties that change meaning: **P4** ("notes do not nest") re-homes
onto the plan; **P5** ("append stamps authorship") retargets to "a card created by a
page-scoped write is stamped" — a new code path. P2's refusal regexes interpolate the
type and will fail loudly. Delete `assertAppendTarget` with its tool; do not leave it
unreferenced.

## Prior art

- `research/2026-08-05-page-agent-notes-mcp-access.md` — the design this supersedes.
- `research/2026-08-03-page-markdown-block-roundtrip.md` — the lossless projection.
- `plugins/page/plugins/markdown-apply/CLAUDE.md` — alignment, pins, the two-channel write.
