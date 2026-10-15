import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import {
  applyMarkdownToBlock,
  loadBlockScope,
  readBlockAsMarkdown,
  serverMarkdownContext,
  type ApplyReport,
} from "@plugins/page/plugins/markdown-apply/server";
import {
  pageTitleBanner,
  parsePageTitleBanner,
  splitPageMeta,
} from "@plugins/page/plugins/markdown-apply/core";
import {
  loadTagVocabularyNames,
  resolveTagNames,
  writeResolvedPageTags,
} from "@plugins/page/plugins/tags/server";
import { TAG_COLORS } from "@plugins/page/plugins/tags/core";
import { renamePage } from "@plugins/page/plugins/editor/server";
import {
  blockAuthorOf,
  dropBlankLinesBesideTags,
  pageBlockHandle,
  type MarkdownContext,
} from "@plugins/page/plugins/editor/core";
import { recordAgentNotesAuthor } from "@plugins/page/plugins/annotations/plugins/agent-notes/plugins/authorship/server";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import {
  assertInstructionsReceived,
  deliverWithRead,
  renderGlobalSection,
} from "./instructions-gate";
import { findEdits } from "./indent-match";
import {
  BRACKET_STATUS_PREFIX,
  metaFactsChanged,
  tagRefusal,
  tagRequestsOf,
} from "./page-tags";
import {
  assertAgentAddressable,
  assertAgentAuthored,
  assertAgentAuthoredPlan,
  inertEmptyParagraphs,
  redactHumanAudience,
} from "./policy";

/**
 * The agent-facing face of a page, as the file triple an agent already knows:
 *
 * ```
 * Read   → read_page(block_id)
 * Write  → write_agent_note(block_id, content)
 * Edit   → edit_page(block_id, old_string, new_string, replace_all)
 * ```
 *
 * `page/markdown-apply` is the engine and stays audience-agnostic — it takes a
 * root, a row filter and a boundary predicate, and knows nothing about who
 * anything is for. These three tools are the POLICY over it (see `./policy.ts`),
 * which is why they live under `annotations`: withholding `/private` and owning
 * `<agent-inline>` and `<agent-page>` are statements about that family, not
 * about markdown.
 *
 * **One parameter name — `block_id` — in all three.** The old
 * `blockId`-means-scope / `noteId`-means-target split dissolved with
 * `append_agent_notes`: a tagless `<agent-inline>` (or `<agent-page title="…">`)
 * in the document is now how a card (or a page) is minted. What the three tools
 * differ in is what they ACCEPT, and that difference is carried by the refusals,
 * which name the tool to use instead.
 *
 * snake_case, matching the file tools (`file_path`, `old_string`, `replace_all`)
 * — and this plugin's results, which were already snake_case.
 */

const jsonResult = (
  value: unknown,
): { content: [{ type: "text"; text: string }] } => ({
  content: [{ type: "text", text: JSON.stringify(value) }],
});

/**
 * The part of an {@link ApplyReport} an agent needs to see.
 *
 * `scope_id` is the root the apply was made at — the id the agent passed, which
 * for `edit_page` is routinely a whole page. It was called `note_id` when the
 * only writable root WAS a card; keeping that name would now claim a page is a
 * note. The agent-authored blocks a write actually touched — cards and pages —
 * are `note_ids`, plural, because one edit may create and revise several of them.
 *
 * `created_page_ids` is the pages among `created_ids`: an `<agent-page>` the
 * document minted comes back as the page AND its body, and the page's id is the
 * one the agent passes back to read or write that page. Without it, telling the
 * page apart from its first paragraph means another read.
 */
function applySummary(
  report: ApplyReport,
  noteIds: readonly string[],
): unknown {
  return {
    scope_id: report.rootId,
    page_id: report.pageId,
    note_ids: noteIds,
    survived: report.stats.survived,
    created: report.stats.created,
    deleted: report.stats.deleted,
    moved: report.stats.moved,
    text_edited: report.textEditedIds.length,
    created_ids: report.createdIds,
    created_page_ids: report.createdPageIds,
    // Writes that came from re-applying the document rather than from the edit
    // itself, dropped before the write was judged. Surfaced rather than hidden:
    // a number climbing here is the projection becoming lossy, which nothing
    // else in this response would show.
    absorbed_writes: report.absorbedWrites,
    // Empty paragraphs outside every agent-authored block are left as they are
    // (see `inertEmptyParagraphs`): said aloud, so an agent whose spacer did
    // not appear knows why rather than retrying it.
    ...inertNote(report.inert),
  };
}

/** The `applySummary` fields for the empty paragraphs an apply left alone. */
function inertNote(inert: ApplyReport["inert"]): object {
  const added = inert.incoming - inert.stored;
  if (added === 0) return {};
  return {
    empty_paragraphs_left_alone:
      added > 0
        ? `${added} empty paragraph${added === 1 ? "" : "s"} you added outside ` +
          `every agent-authored block ${added === 1 ? "was" : "were"} not written ` +
          `— the page's own layout is not yours to change. Nothing else was affected.`
        : `${-added} empty paragraph${added === -1 ? "" : "s"} you left out ` +
          `${added === -1 ? "is" : "are"} outside every agent-authored block, so ` +
          `${added === -1 ? "it was" : "they were"} kept. Nothing else was affected.`,
  };
}

/**
 * Stamp this conversation onto every agent-authored block a write touched —
 * cards and pages alike, one authorship table for both.
 *
 * AFTER the patch commits, always: `page_blocks_agent_authors.block_id` FKs onto
 * the row, so stamping a card — or a page — the same call just created is a
 * foreign-key violation until then. `recordAgentNotesAuthor` is
 * `onConflictDoNothing`, so re-stamping one this conversation already wrote is
 * free. The EARLIEST stamp is a page's creator (the chip its row shows): a page
 * minted here is stamped by the conversation that minted it, and an empty one a
 * human inserted with `/agent-page` by its first writer. A crash between the
 * commit and this loop leaves a page with no creator — nothing corrupt, only an
 * absent chip.
 *
 * The tool layer is where `conversationId` exists at all — neither the engine nor
 * the policy ever learns one.
 */
async function stampAuthors(
  cardIds: Iterable<string>,
  conversationId: string,
): Promise<void> {
  for (const id of new Set(cardIds))
    await recordAgentNotesAuthor(id, conversationId);
}

/**
 * An edited page-rooted document read as a RENAME: the new title its `# …` line
 * states, and the document with that line put back to the stored banner.
 *
 * Why the line is put BACK rather than stripped: the banner is a reader-side
 * prefix, never a block (`markdown-apply/core/page-title.ts`), and the content
 * apply takes it off by byte-identity with the STORED title's banner. Handing the
 * apply the stored line keeps that the one rule — the apply sees an unchanged
 * title, strips it as it always does, and the baseline subtraction (which strips
 * the same line off the pre-edit read) sees the two documents agree about it. So
 * the title never reaches the planner, where a changed one would be a created
 * heading, and the rename is written separately, through the page row's `data`.
 *
 * The line is found by the strip's own rule — the first NON-EMPTY line — so the
 * line replaced here is exactly the one the strip will compare. It must be
 * followed by an empty line (the one the banner emits, which the strip consumes
 * with it) or by the end of the document; anything else means the edit ran the
 * title into the next block, and which half of that was the title is not
 * something to guess.
 *
 * **A rename changes the title line and nothing else.** With the stored line put
 * back, the document must be byte-identical to `original`, the read the edit was
 * spliced into. Without that rule, deleting the banner of a page whose first
 * block is an H1 would read as "rename to that heading, and delete it" — the two
 * documents are the same bytes, and there is nothing else to tell them apart by.
 * With it, the edit is a rename only when the title line is the one thing that
 * moved, which is a fact about the two documents rather than a guess about one.
 * A rename plus a content change is two `edit_page` calls — and the rename is
 * then the call's only write, so it never lands half of an edit.
 *
 * Refusals are data, not throws: the caller owns the status and the wording.
 */
type TitleEdit =
  { ok: true; title: string; document: string } | { ok: false; reason: string };

function titleEditOf(
  next: string,
  original: string,
  storedLine: string,
  ctx: MarkdownContext,
): TitleEdit {
  const lines = next.split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i += 1;
  if (i >= lines.length) {
    return {
      ok: false,
      reason: "the edit leaves no title line at all",
    };
  }
  const parsed = parsePageTitleBanner(lines[i]!, ctx);
  if (!parsed.ok) return parsed;
  if (i + 1 < lines.length && lines[i + 1] !== "") {
    return {
      ok: false,
      reason:
        "the title line must be followed by a blank line, and here the next " +
        `line is ${JSON.stringify(lines[i + 1])}`,
    };
  }
  lines[i] = storedLine;
  const document = lines.join("\n");
  if (document !== original) {
    return {
      ok: false,
      reason:
        "a rename must change the title line and nothing else — this edit also " +
        "changes the page's content (or removes the title line). Rename in one " +
        "edit_page call and make the other change in another",
    };
  }
  return { ok: true, title: parsed.title, document };
}

/**
 * `text` without a leading `<page-meta>` header — or `text` itself when it has
 * none, or when what opens it is not a well-formed header (that is then matched
 * as written, and refused by the apply if it ever reaches one).
 */
function withoutPageMeta(text: string): string {
  const split = splitPageMeta(text);
  return split.ok && split.meta !== null ? split.rest : text;
}

/**
 * Whether `text` opens with exactly the header `readHeader` — the one this
 * read emitted. Such an `old_string` is matched as written (header included),
 * so an edit of the header's `<tags>` section through a whole pasted header
 * lands; any OTHER header (another read's) is dropped before matching.
 */
function opensWithHeader(text: string, readHeader: string): boolean {
  const split = splitPageMeta(text);
  return (
    split.ok &&
    split.meta !== null &&
    split.header.trimEnd() === readHeader.trimEnd()
  );
}

export const readPageTool = Mcp.tool({
  name: "read_page",
  description: `Read a Singularity page — or any block within one — as markdown.

**This tool reads the SHARED instance (normally main), not your worktree** — the
opposite default from \`query_db\`, because pages are prod documents you edit
collaboratively with the user, not something to test on.

\`block_id\` is the SCOPE, not a line in the output: you get that block's
sub-blocks. A page's id gives the whole page, opening with a \`# Title\` line.

**Every read opens with a \`<page-meta>\` header** saying where the content
comes from:

    <page-meta kind="page" created="2026-07-14T09:12Z" edited="2026-10-07T18:02Z">
      <tags>
        <tag name="In progress"/>
      </tags>
      <breadcrumb>
        <page id="…" title="Workspace"/>
        <page id="…" title="This page"/>
      </breadcrumb>
      <backlinks>
        <page id="…" title="A page linking here"/>
      </backlinks>
    </page-meta>

\`kind\` says whose page holds what you read, and so what you may write in it:

- \`kind="page"\` — the author's page. Its prose is theirs and read-only to you;
  you write only inside \`<agent-inline>\` cards on it (or agent pages under it).
- \`kind="agent-page"\` — an AGENT PAGE: the whole page is yours to write,
  prose included, except \`<human>\` and \`<todo>\` cards. Text you find on it
  may still be the author's — they can type on an agent page — so treat changing
  or deleting lines you did not write as you would on their page: only when asked.
- \`kind="instructions"\` — the author's standing instructions; read-only to you.

The breadcrumb runs from the root page down to the page holding what you read
(the last entry), including when you read a block inside it. The backlinks are
the other pages that link TO that page (a link block or an inline \`[[\` mention),
by title — \`<backlinks/>\` when none does; read one to see where and why it
links here. Every id in the header is a \`block_id\` you can read. \`created\` and \`edited\` are UTC — \`edited\` is the
latest change to the page or any block in it, so it tells you how stale a note
or todo may be. \`<tags>\` lists the page's tags (\`<tags/>\` when it has
none) — its status and labels, drawn from one shared vocabulary. The header is
not part of the page, and apart from \`<tags>\` it is READ-ONLY: hand it back
unchanged or leave it out; an edit to it is ignored. \`edit_page\` describes
how to change the tags. A page's status ("In progress", "Done", …) is a TAG,
never a \`[…]\` prefix in its title.

Four things in the output are ADDRESSES, and all of them matter when you write
back:

- \`<agent-inline id="…">\` — an agent card, placed inline among the page's own
  blocks. What an agent writes to a page lives inside one of these, or in an
  agent page (next).
- \`<agent-page id="…" title="…"/>\` — an AGENT PAGE: a sub-page an agent created,
  whose whole content is the agent's to write. Here it is only a pointer; its
  content lives in its own page — pass its id as \`block_id\` to read or write it.
- \`<human id="…">\` — a card the page's author wrote. Same kind of address, the
  opposite permission: see below.
- \`<page id="…" title="…"/>\` — a pointer at another page: one of the author's
  sub-pages, or a link to a page. Leave it alone: the id is how a later write
  reconciles the pointer against the existing page instead of destroying it.

An \`<agent-inline>\` id and an \`<agent-page>\` id are what \`write_agent_note\`
takes. On both pointers \`title\` is READ-ONLY — shown so you can tell pages
apart without opening each one; editing it changes nothing.

**\`<human>\` and \`<todo>\` cards are the page author's OWN words.** A \`<human>\`
card is what they wrote for you — conventions, corrections, "the writer is in
encode.ts"; a \`<todo>\` card is work they assigned. Read both, follow both, and
never write one: you may not create a \`<human>\` or \`<todo>\` card, and you may
not change, move or drop an existing one. That holds even when the card sits
INSIDE your own \`<agent-inline>\` card or agent page — nesting one there is
exactly how the author answers you inside your own note, and it stays theirs.
Hand every such card back byte-identical, id and all; reply beside it, in the
block that holds it.

The markdown is a faithful projection of the block forest: what this returns
re-parses to exactly the same blocks. Hand a line back the way you found it and
it is not a write — an edit is judged only on what YOU changed, so the rest of
the document costs you nothing and you never have to repair the projection by
hand. What that asks of you is the other half: change only the text you mean to
change, and leave everything else byte-identical.

A \`\\n\` inside a line is part of that projection: it is a soft line break
WITHIN that block, the same as pressing Shift+Enter in the editor, and not a
block boundary. Hand it back unchanged, like everything else, and it is not a
write.

A LEADING \`\\\` is part of it too: it marks a line as plain prose whose words
merely start like something else — \`\\3. Step one\`, \`\\- not a bullet\`,
\`\\# not a heading\`. The paragraph's text is everything after that one
backslash. Keep it when you hand the line back, and put one there yourself if an
edit makes a paragraph start with \`-\`, \`+\`, \`#\`, \`>\`, \`$$\`, \`---\` or
a number followed by \`.\` or \`)\` — without it the line comes back as a list,
heading or divider instead of the paragraph you wrote.

Some tags also carry READ-ONLY attributes describing state that lives outside
the page — facts about the block held elsewhere in the system, not text anyone
typed into the document. Write them back exactly as you found them. Editing one
changes nothing: the value comes from its own owner, and a write is judged on
the blocks it touches, so an edited attribute is simply ignored. To change what
such an attribute reports, act on the thing it describes.

**Content may be missing, with nothing marking where.** Cards the page's author
addressed to themselves (\`/private\`) are removed from this output entirely,
along with everything inside them. So a gap in the prose may be a note you are
not meant to see rather than something missing: do not "restore" it, and do not
read this text as proof of what the author has or has not already written down.

**Instructions may come first.** A page's author can leave instructions for
agents working under a page — the way a CLAUDE.md file does for a folder. When
the page you read is covered by instructions this conversation has not received
yet (or that changed since), the output opens with a
\`<received-instructions>\` block holding them, each tagged with its id and the
page it covers; the page itself follows it. That block is not part of the page:
never copy it into an edit. Instructions arrive once per conversation, and again
only after they change. Global instructions arrived with this server's
instructions when the conversation started. An instructions card the page shows
in full (\`<instructions id="…">\`) is not repeated in the block.

There is no offset/limit, deliberately — a line window can open a tag it never
closes. To read less, pass the id of the block you care about; that is what the
ids in the output are for.

To write: \`write_agent_note\` replaces the whole contents of one
\`<agent-inline>\` card or agent page; \`edit_page\` changes anything, as long as
every block it touches sits inside an \`<agent-inline>\` card or an agent page,
and not inside a \`<human>\` or \`<todo>\` card within it.`,
  inputSchema: {
    block_id: z
      .string()
      .min(1)
      .describe(
        "The page's block id, or any block within it to scope the read to.",
      ),
  },
  async handler({ block_id: blockId }, ctx) {
    // The scope is loaded here to decide ABOUT the block (rule 2) and again
    // inside the engine to serialize it. Two reads, deliberately: the policy
    // question is "may this id be addressed at all", which has to be answered
    // before the id is handed over as a root, and the engine's own read is what
    // keeps its walk and its rows one thing.
    const scope = await loadBlockScope(blockId);
    assertAgentAddressable(scope, blockId);
    const markdown = await readBlockAsMarkdown(blockId, {
      redact: redactHumanAudience,
      meta: true,
    });
    // The instructions covering this page that the conversation has not
    // received yet go AHEAD of the page, and now count as received.
    const preamble = await deliverWithRead({
      conversationId: ctx.conversationId,
      pageId: scope.pageId,
      readRootId: blockId,
      body: markdown,
    });
    const text = preamble === "" ? markdown : `${preamble}\n\n${markdown}`;
    return { content: [{ type: "text" as const, text }] };
  },
});

export const writeAgentNoteTool = Mcp.tool({
  name: "write_agent_note",
  description: `Replace the whole contents of ONE agent-authored block — an \`<agent-inline>\` card or an agent page — with a markdown document.

**This writes to the SHARED instance (normally main), not your worktree** — the
opposite default from \`query_db\`, because pages are prod documents you edit
collaboratively with the user, not something to test on. What you write is live
for them at once and outlives your worktree.

\`block_id\` must name one of the two — copy the id off the tag \`read_page\`
emits:

- \`<agent-inline id="…">\` — a card inline in a page. \`content\` becomes the
  card's children.
- \`<agent-page id="…" title="…"/>\` — an agent page. A page's content is written
  by its OWN id: \`content\` becomes the page's whole content. If it opens with
  the page's \`# Title\` line exactly as \`read_page\` showed it, that line is
  dropped rather than written (so is a leading \`<page-meta>\` header, on any
  block). Any OTHER \`# …\` line is an ordinary heading
  inside the page's content — the title itself is not writable here, because a
  new \`# …\` line cannot be told apart from a first heading. To RENAME an agent
  page, use \`edit_page\` on its \`# Title\` line.

To CREATE one, use \`edit_page\` on the page that should hold it: a tagless
\`<agent-inline>\` … \`</agent-inline>\` mints a card where you put it, and
\`<agent-page title="…">\` … \`</agent-page>\` mints an agent page there, its
body becoming the new page's content. There is no separate append tool.

\`content\` is the block's CONTENTS, not the block. Write ordinary markdown
(paragraphs, lists, headings); do not wrap it in an \`<agent-inline>\` tag
yourself, or you get a card inside this one rather than the contents of this one
(nesting is legal, so nothing will stop you).

A blank line between two paragraphs is an empty paragraph, the same as pressing
Enter twice in the editor: blocks are one per line here, so it becomes a spacer
block of its own rather than whitespace. A blank line you write next to a tag line
(\`<…>\` or \`</…>\`) is just spacing; an empty paragraph that really sits
beside a tag reads as \`<text/>\`.

This is a MERGE, not an overwrite: the incoming document is aligned against the
block's existing children, so unchanged blocks keep their identity (and with it
their edit history, stars, backlinks and any task launched from them). Only what
really changed is written.

**If the block contains a \`<human id="…">\` or \`<todo id="…">\` card, your
\`content\` must echo it back verbatim, id and all.** Those are the page author's
own words — typically their answer to you, written inside your own card or page —
and they are not yours to rewrite or to drop. \`content\` is the block's WHOLE
new contents, so a document that simply leaves such a card out is a document that
plans its deletion: the whole write is refused and NOTHING is written, not even
the parts that were fine. \`read_page\` the block first and edit that text; that
is the only way to be sure you are echoing what is actually there. The same goes
for \`<page id="…"/>\` and \`<agent-page id="…"/>\` pointers inside an agent page:
a sub-page is never deleted by leaving it out, but hand the pointers back anyway.

Always \`read_page\` the block first (\`read_page\` with its id returns exactly
this document) and edit THAT text: a document written from memory loses every
block the projection encoded and re-mints the blocks it fails to reproduce
byte-for-byte. Prefer \`edit_page\` for a localized change — same machinery, far
smaller chance of rewriting the whole block by accident.

**A write can be refused because of instructions.** If the page is covered by
instructions from its author that this conversation has not received yet (or
that changed since), the write is refused with nothing written, and the refusal
carries those instructions in full. They then count as received: read them, and
retry if the write still follows them. Reading the page with \`read_page\` first
delivers them the same way.

The block records that THIS conversation wrote it, so a human reading the page
can open the run that produced it. Returns what the write actually did
(survived / created / deleted / moved).`,
  inputSchema: {
    block_id: z
      .string()
      .min(1)
      .describe(
        "The `<agent-inline>` card's or agent page's block id, as read_page emits it.",
      ),
    content: z
      .string()
      .describe(
        "The block's full new contents, in the same dialect `read_page` emits.",
      ),
  },
  async handler({ block_id: blockId, content }, ctx) {
    const scope = await loadBlockScope(blockId);
    assertAgentAuthored(scope, blockId);
    // Before anything is planned: a refusal here has written nothing.
    await assertInstructionsReceived({
      tool: "write_agent_note",
      conversationId: ctx.conversationId,
      pageId: scope.pageId,
    });
    // The block set the acceptance predicate resolved, carried out of the hook.
    // `assertAcceptable` returns void by design — its only verdict is throwing —
    // so the answer it computes on the way rides out on a closure rather than
    // being walked a second time here.
    let authored: string[] = [];
    // A blank line the agent put beside a tag is spacing, not an empty
    // paragraph (see `dropBlankLinesBesideTags`).
    const spaced = dropBlankLinesBesideTags(
      content,
      serverMarkdownContext().handles,
    );
    const report = await applyMarkdownToBlock(blockId, spaced, {
      // The SAME filter the read used, which is what makes the apply a diff
      // against the document the agent actually saw.
      redact: redactHumanAudience,
      inert: inertEmptyParagraphs,
      assertAcceptable: (plan, { rows, pageRow }) => {
        authored = assertAgentAuthoredPlan({
          plan,
          rows,
          pageRow,
          rootId: blockId,
        });
      },
    });
    // The target is stamped even when the diff was empty: "I wrote this" is true
    // either way, and an agent that re-sends an unchanged document has still
    // taken authorship of what it says.
    await stampAuthors([blockId, ...authored], ctx.conversationId);
    return jsonResult(
      applySummary(report, [
        blockId,
        ...authored.filter((id) => id !== blockId),
      ]),
    );
  },
});

export const editPageTool = Mcp.tool({
  name: "edit_page",
  description: `Replace an exact string in a page, the way \`Edit\` replaces one in a file.

**This writes to the SHARED instance (normally main), not your worktree** — the
opposite default from \`query_db\`, because pages are prod documents you edit
collaboratively with the user, not something to test on. Your edit is live for
them at once and outlives your worktree.

THE ONE RULE: **every block this edit creates, rewrites, moves or deletes must
sit inside an agent-authored block — an \`<agent-inline>\` card or an agent page
— and not inside a \`<human>\` or \`<todo>\` card within it.** The page's own
prose is read-only to an agent — you annotate it, you do not rewrite it — and so
is a card the author wrote, wherever it sits. The rule is one walk: from each
block you touched, go up until you reach something that says whose words it
holds; \`<agent-inline>\` and an agent page say yours, \`<human>\` and
\`<todo>\` say theirs, and reaching the top of a page the author wrote without
meeting either means the page's own prose, which is theirs too. You may not
create a \`<human>\`, \`<todo>\` or \`<private-note>\` card anywhere, including
inside your own — to file work, use \`add_task\`.

Two ways to add something of your own, both TAGLESS — a tag with an id names a
block that already exists:

- \`<agent-inline>\` … \`</agent-inline>\` — a card, right where you put it,
  among the page's blocks. For an annotation on a line.
- \`<agent-page title="…">\` … \`</agent-page>\` — an AGENT PAGE: a new sub-page
  in this page, its body becoming the new page's content, all of it yours. For
  something long enough to deserve its own page. It comes back from \`read_page\`
  as the pointer \`<agent-page id="…" title="…"/>\`, and the result's
  \`created_page_ids\` names it. After that, a page's content is written by its
  OWN id — pass it as \`block_id\` (here or to \`write_agent_note\`); a pointer
  with a body, or with any attribute besides \`title\`, is refused. Its
  \`title\` is read-only on the pointer: set it when you create the page, and
  rename it later through the page's own \`# Title\` line (below).

\`block_id\` is only the SCOPE the edit applies to (a page id for the whole
page); what is allowed is judged by what the resulting diff TOUCHED, not by which
id you passed. Scoped to an agent page's own id, every block in it is yours —
the \`<page-meta>\` header's \`kind="agent-page"\` says you are on one.

**The \`<page-meta>\` header** that opens every \`read_page\` output is not part
of the page. Its \`<tags>\` section is the page's TAGS, and is writable; the
rest of it is read-only: an edit that changes the rest writes nothing there (the
result then carries \`page_meta_ignored\`), and one that leaves the header
malformed is refused. Anchor \`old_string\` below it. A header leading
\`old_string\` that is NOT exactly this read's (say, one pasted from another
read) is dropped before matching, with the one leading \`new_string\`.

**Tags.** A page's tags are its status and labels ("In progress", "Planned",
"Done", …), drawn from ONE shared vocabulary — listed at the END of this
description, as of when you loaded it. **Status belongs in tags, never in
a \`[…]\` prefix in the title** — a rename to such a title is refused. To change
a page's tags, edit its \`<tags>\` section like any other text — one
\`<tag name="…"/>\` line per tag, in the order the page shows them;
\`<tags/>\` when it has none:

       edit_page(block_id:   "<page id>",
                 old_string: "  <tags/>",
                 new_string: "  <tags>\\n    <tag name=\\"In progress\\"/>\\n  </tags>")

- Tags may be set on ANY page, the author's included — they are metadata, not
  the author's prose. They land on the page holding \`block_id\` (the last
  breadcrumb entry), whatever block you scoped the edit to.
- A name matches an existing tag case- and whitespace-insensitively, and is
  stored under that tag's spelling; a name listed twice counts once.
- **A name that matches no existing tag is REFUSED**, with nothing written (your
  content change included), and the refusal lists the closest names and the
  whole vocabulary — use one of those. Only when you really mean a NEW tag, say
  so on its line: \`<tag name="Blocked" new="true"/>\`, optionally with
  \`color="red"\` (one of ${TAG_COLORS.join(", ")}; else one is picked from
  the name). \`new\` and \`color\` are only for
  creating; an existing tag keeps its color.
- The tags are written after the rest of the edit succeeds. The result carries
  \`tags_set\` (the page's tags as stored) and, when any were made,
  \`tags_created\`.

**The \`# Title\` line.** Scoped to a page's own id, the document opens (after
the header) with the page's title as \`# Title\` and a blank line. It is not a
block of the page.

- **On an agent page it IS the page's title, and editing it renames the page.**
  Change only the text after \`# \`, and keep it one \`# \` line followed by a
  blank line; the result then carries \`renamed_to\`. A title opening with a
  \`[…]\` prefix (\`[In progress] …\`) is refused: put the status in tags. A rename is an edit of
  that line ALONE — to also change the page's content, make that a second
  \`edit_page\` call. A title is plain text — no
  bold, code or links — written the way \`read_page\` would show it (a literal
  \`*\` stays escaped as \`\\*\`); anything else is refused with the spelling that
  would be accepted.
- **On any other page it is read-only.** An edit that changes it is refused.

A blank line between two paragraphs is an empty paragraph, the same as pressing
Enter twice in the editor. Blocks are one per line in this document, so such a
blank line you add is a new block. A blank line next to a tag line (\`<…>\` or
\`</…>\`) is just spacing, so you may put blank lines around a card you insert;
an empty paragraph that really sits beside a tag reads as \`<text/>\`.
Outside every agent-authored block, empty paragraphs are the page's layout and
this edit leaves them alone: one you add (a blank line or \`<text/>\`) is not
written, one you leave out is kept, and the result's
\`empty_paragraphs_left_alone\` says so. Neither refuses the edit.

A \`\\n\` INSIDE a line is the opposite: a soft line break within that block, the
same as pressing Shift+Enter in the editor rather than Enter. It is part of that
line's text, not a block boundary, so handing one back unchanged is not a write —
and adding one gives you a break inside a block where a new line would have given
you a new block.

A LEADING \`\\\` marks a line as a plain paragraph whose words merely start like
something else (\`\\3. Step one\`, \`\\- not a bullet\`). Keep it where you find
one, and add one when your edit makes a paragraph begin with \`-\`, \`+\`, \`#\`,
\`>\`, \`$$\`, \`---\` or a number followed by \`.\` or \`)\` — otherwise the line
is read back as a list, heading or divider rather than the paragraph you meant.

A worked round trip:

1. \`read_page(block_id: "<page id>")\` →

       # Parser notes

       The parser handles UTF-8.

       <agent-inline id="block-77">
       Checked the writer.
       <human id="block-90">
       No — the writer is in encode.ts.
       </human>
       </agent-inline>

2. Annotate that prose line — the line itself comes back byte-identical, and the
   only new block sits in a new, TAGLESS card:

       edit_page(
         block_id:   "<page id>",
         old_string: "The parser handles UTF-8.",
         new_string: "The parser handles UTF-8.\\n<agent-inline>\\nUTF-16 input is rejected in decode.ts.\\n</agent-inline>",
       )

3. Revise what you wrote earlier — inside the existing card, so it is yours:

       edit_page(block_id: "<page id>",
                 old_string: "Checked the writer.",
                 new_string: "Checked the writer and the reader.")

4. REFUSED — this rewrites a prose block that is inside no card:

       edit_page(block_id: "<page id>",
                 old_string: "The parser handles UTF-8.",
                 new_string: "The parser handles UTF-16.")

       403: block block-12 was edited outside every agent-authored block. …

5. REFUSED — this one is INSIDE your own card, and still refused, because the
   line it rewrites is inside the \`<human>\` card the author nested there:

       edit_page(block_id: "<page id>",
                 old_string: "No — the writer is in encode.ts.",
                 new_string: "No — the writer is in decode.ts.")

       403: block block-91 was edited, and it sits inside <human> card block-90. …

   Same for deleting it, moving it out, or leaving it out of a
   \`write_agent_note\` on block-77. Answer it in block-77, below the card.

**A write can be refused because of instructions.** If the page is covered by
instructions from its author that this conversation has not received yet (or
that changed since), the edit is refused with nothing written, and the refusal
carries those instructions in full. They then count as received: read them, and
retry if the edit still follows them. Reading the page with \`read_page\` first
delivers them the same way. An \`<instructions>\` card is the author's, like a
\`<human>\` card: hand it back byte-identical.

Contract, matching the \`Edit\` file tool:
- \`old_string\` must appear at least once; zero matches is an error.
- It must be UNIQUE unless \`replace_all\` is true; a non-unique match is an
  error naming how many were found. Include surrounding lines to disambiguate.
- \`old_string\` and \`new_string\` must differ.
- Indentation may be off by a uniform amount. A read scoped to a block holds
  what is nested under it, starting at depth zero, so a line copied from a
  whole-page read carries leading spaces that read has not. With no exact match, \`old_string\` is tried
  again with every line shifted by the same leading whitespace, and
  \`new_string\` is shifted with it (the result then says \`reindented\`). The
  indentation BETWEEN lines must still match exactly.

Match against what \`read_page\` returns for this \`block_id\`, not against what
you imagine it says. Everything outside your own blocks must come back
byte-identical — including the \`# Title\` line of a page its author wrote (on an
agent page, editing it renames the page, above), every \`<page id="…"/>\` and
\`<agent-page id="…"/>\` pointer, and every \`<human>\` / \`<todo>\` card, which is
the author's even when it sits in yours.`,
  // The vocabulary lives in the database, so it cannot be part of the fixed
  // text: it is rendered when the client lists the tools (at connect), which is
  // what an agent sees on loading this tool. A tag created since is still
  // accepted by name; an unknown one's refusal lists the vocabulary as of then.
  liveDescription: async () => {
    const names = await loadTagVocabularyNames();
    return names.length === 0
      ? "**Page tags that exist now:** none yet."
      : `**Page tags that exist now:** ${names
          .map((n) => JSON.stringify(n))
          .join(
            ", ",
          )}. Use one of these; create a new tag only when none fits.`;
  },
  inputSchema: {
    block_id: z
      .string()
      .min(1)
      .describe("The page id, or any block within it, to scope the edit to."),
    old_string: z
      .string()
      .min(1)
      .describe(
        "Exact text to replace, as it appears in `read_page`'s output (a uniform indentation shift is tolerated).",
      ),
    new_string: z.string().describe("Replacement text."),
    replace_all: z
      .boolean()
      .default(false)
      .describe(
        "Replace every occurrence instead of requiring a unique match.",
      ),
  },
  async handler(
    {
      block_id: blockId,
      old_string: oldString,
      new_string: newString,
      replace_all: replaceAll,
    },
    ctx,
  ) {
    if (oldString === newString) {
      throw new HttpError(
        400,
        `edit_page: old_string and new_string are identical, so this edit asks for ` +
          `no change. Pass the text you want instead as new_string.`,
      );
    }
    const scope = await loadBlockScope(blockId);
    // The READ door, not the write one: this tool reads the scope as markdown
    // before it edits, so a block inside a private card is refused here for the
    // same reason `read_page` refuses it. What may be WRITTEN is judged on the
    // plan, below.
    assertAgentAddressable(scope, blockId);
    // Before the edit is even matched: whatever it would write, it waits until
    // the page's instructions have been received. A refusal writes nothing.
    await assertInstructionsReceived({
      tool: "edit_page",
      conversationId: ctx.conversationId,
      pageId: scope.pageId,
    });
    const markdown = await readBlockAsMarkdown(blockId, {
      redact: redactHumanAudience,
      // The document the agent matched old_string against is read_page's, and
      // that one opens with the header.
      meta: true,
    });

    // A blank line the agent put beside a tag — `</human>\n\n<agent-inline>` —
    // is spacing, not an empty paragraph minted in the page's prose. Only
    // `new_string` is the agent's own text: a spacer already on the page stays a
    // spacer when a card lands beside it (see `dropBlankLinesBesideTags`).
    //
    // A `<page-meta>` header leading old_string is dropped before matching (and
    // one leading new_string with it): the header is read-only and differs per
    // read root, so an old_string copied from ANOTHER read — a block's read,
    // pasted against its page — would otherwise never match, over lines the edit
    // cannot change anyway.
    //
    // An old_string opening with THIS read's header, byte for byte, is matched
    // as written — that is a whole pasted header whose `<tags>` section the
    // edit may be changing — and new_string keeps its header with it.
    const readSplit = splitPageMeta(markdown);
    if (!readSplit.ok) {
      throw new Error(
        `edit_page: the document read_page produced for ${blockId} has a malformed ` +
          `<page-meta> header (${readSplit.reason})`,
      );
    }
    const ownHeader = opensWithHeader(oldString, readSplit.header);
    const oldBody = ownHeader ? oldString : withoutPageMeta(oldString);
    if (oldBody.trim() === "") {
      throw new HttpError(
        400,
        `edit_page: old_string holds only a <page-meta> header from another ` +
          `read, which is not part of the page. Anchor old_string below it — ` +
          `or, to change this page's tags, on its <tags> section.`,
      );
    }
    const tryFind = (withHeader: boolean) =>
      findEdits(
        markdown,
        withHeader ? oldString : withoutPageMeta(oldString),
        dropBlankLinesBesideTags(
          withHeader ? newString : withoutPageMeta(newString),
          serverMarkdownContext().handles,
        ),
      );
    let found = tryFind(ownHeader);
    // A BLOCK's read under the same page carries the very same header, yet its
    // body sits at another depth than the page's: pasted whole against the page
    // it cannot match with the header in front. Its header is then just the
    // read-only header of another read, and is dropped like any other.
    if (found.kind === "none" && ownHeader) found = tryFind(false);
    if (found.kind === "none") {
      throw new HttpError(
        400,
        `edit_page: old_string was not found in ${blockId}, not even with its ` +
          `indentation shifted, so the difference is in the text itself. Call ` +
          `read_page on that id and copy the text to replace out of its output ` +
          `verbatim — a card the page's author addressed to themselves is not in ` +
          `it, so text you remember from elsewhere may not be there.`,
      );
    }
    if (found.kind === "new-string-shallower") {
      throw new HttpError(
        400,
        `edit_page: old_string matched ${blockId} only at a different ` +
          `indentation, and new_string has a line indented less than old_string's ` +
          `lines, so there is no one depth to move it to: ${JSON.stringify(found.line)}. ` +
          `Copy old_string from read_page on that id, and indent new_string from there.`,
      );
    }
    const { edits } = found;
    const matches = edits.length;
    const shift = edits[0].shift;
    if (matches > 1 && !replaceAll) {
      const depths =
        shift === null
          ? ""
          : ` after shifting its indentation (at ${edits
              .map((e) => `${e.shift?.to.length ?? 0}`)
              .join(", ")} characters of indentation)`;
      throw new HttpError(
        400,
        `edit_page: old_string matches ${matches} times in ${blockId}${depths}. ` +
          `Include more surrounding text to make it unique, or pass replace_all: true.`,
      );
    }
    // Spliced by offset rather than `String.replace`, whose replacement string
    // gives `$&`, `$1`, … a meaning the caller never asked for. Last edit first,
    // so the earlier offsets still hold.
    let next = markdown;
    for (const edit of (replaceAll ? [...edits] : [edits[0]]).reverse()) {
      next =
        next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
    }

    // The `# Title` banner is a READER-SIDE PREFIX, not a block: a page-rooted
    // read prepends it and the apply strips it back off by BYTE-IDENTITY. An edit
    // that rewrote it would therefore fail that test, fall through to the planner
    // as a created heading, and — inside an agent page, where every block is the
    // agent's — LAND as one. So it is caught here, where the two documents are
    // both in hand and the diagnosis is exact, and it has exactly two outcomes:
    //
    //  - **On an agent-authored page it is a RENAME**, when the edited document
    //    still opens with one well-formed `# …` line and that line is the only
    //    thing the edit changed (`titleEditOf`). The page's title is then the
    //    agent's to set, as every block of the page is. The line is put back to
    //    the stored banner — which makes the content apply plan nothing — and the
    //    new title is written through the page row's `data`: the banner never
    //    becomes a node.
    //  - **Anywhere else it is refused**, with a message naming the title and the
    //    fix: a human's page title is the human's, as its prose is, and on an
    //    agent page a deleted or mangled title line is not a title an agent
    //    stated, so it is not guessed at.
    //
    // Whose page it is is asked off `scope.pageRow` through `blockAuthorOf`, the
    // one resolution of the author axis — the same question the write policy
    // asks of every row. It is asked here on the scope loaded above, and asked
    // AGAIN under the page row's lock by `renamePage` (`requireAuthor`), because
    // a human can flip the page between the two; a check only here would race.
    // The `<page-meta>` header comes off both documents before anything else
    // reads them: it sits ahead of the `# Title` line, and it is read-only — its
    // fields are facts held elsewhere (the page's ancestry and timestamps), so
    // an edit to it is ignored, and said to be. A header the edit left
    // malformed (a line it does not know, no closing tag) is refused instead,
    // because content written inside it would otherwise vanish.
    //
    // The header's ONE writable section is `<tags>`: the page's tags, by name
    // (see `./page-tags.ts`). Its change is resolved below, before anything is
    // written, and written after the content apply. Every other field is still
    // ignored, and said to be — judged with the tags taken out, so a tag edit
    // is not reported as an ignored header edit.
    const nextSplit = splitPageMeta(next);
    if (!nextSplit.ok) {
      throw new HttpError(400, `edit_page: ${nextSplit.reason}.`);
    }
    const metaIgnored =
      nextSplit.meta === null
        ? nextSplit.header !== readSplit.header
        : metaFactsChanged(readSplit.meta, nextSplit.meta);
    const tagRequests = tagRequestsOf(readSplit.meta, nextSplit.meta);
    if (tagRequests !== null && !tagRequests.ok) {
      throw new HttpError(400, `edit_page: ${tagRequests.reason}`);
    }
    const body = readSplit.rest;
    const nextBody = nextSplit.rest;

    let document = nextBody;
    let renamedTo: string | undefined;
    if (blockId === scope.pageId) {
      const mdCtx = serverMarkdownContext();
      const banner = pageTitleBanner(scope.title, mdCtx);
      if (body.startsWith(banner) && !nextBody.startsWith(banner)) {
        const titleIs =
          `this edit changes the document's first line, which is page ` +
          `${scope.pageId}'s TITLE and not a block of the page`;
        if (blockAuthorOf(pageBlockHandle, scope.pageRow.data) !== "agent") {
          throw new HttpError(
            400,
            `edit_page: ${titleIs} — read_page prepends it, and no edit can write ` +
              `it on a page its author wrote. Anchor old_string below the blank ` +
              `line that follows the title, or scope the edit to a block inside ` +
              `the page instead of the page itself.`,
          );
        }
        const edit = titleEditOf(
          nextBody,
          body,
          banner.slice(0, banner.indexOf("\n")),
          mdCtx,
        );
        if (!edit.ok) {
          throw new HttpError(
            400,
            `edit_page: ${titleIs}. This is an agent page, so you may rename it: ` +
              `change only the text after "# ", and keep the title one "# " line ` +
              `followed by a blank line. Not renamed, and nothing written, ` +
              `because ${edit.reason}.`,
          );
        }
        if (BRACKET_STATUS_PREFIX.test(edit.title)) {
          throw new HttpError(
            400,
            `edit_page: not renamed, and nothing written: the new title ` +
              `${JSON.stringify(edit.title)} opens with a […] prefix. A page's ` +
              `status belongs in its TAGS, never in its title — keep the title ` +
              `plain and put the status in the header's <tags> section ` +
              `(<tag name="In progress"/>).`,
          );
        }
        document = edit.document;
        if (edit.title !== scope.title) renamedTo = edit.title;
      }
    }

    // A changed tag list is resolved BEFORE anything is written: an unknown
    // name (not marked new="true") refuses the whole edit, content included.
    // It is written AFTER the content apply, so a refused content edit writes
    // no tags either.
    const tagResolution =
      tagRequests === null ? null : await resolveTagNames(tagRequests.requests);
    if (tagResolution !== null && !tagResolution.ok) {
      throw new HttpError(400, `edit_page: ${tagRefusal(tagResolution)}`);
    }

    let authored: string[] = [];
    const report = await applyMarkdownToBlock(blockId, document, {
      // `body` is what this tool read a moment ago (header off) and `document`
      // is that same string with one splice in it (a rename's title line put
      // back to the stored one), so every write the two have in common is the
      // round trip's own and not this edit's. Without it the boundary rule below
      // judges the caller for blocks the projection touched.
      baseline: body,
      redact: redactHumanAudience,
      inert: inertEmptyParagraphs,
      assertAcceptable: (plan, { rows, pageRow }) => {
        authored = assertAgentAuthoredPlan({
          plan,
          rows,
          pageRow,
          rootId: blockId,
        });
      },
    });
    // Nothing is stamped when nothing changed: unlike `write_agent_note`, this
    // tool names no block of its own, so an edit that touched no agent-authored
    // block has no authorship to claim. A page it MINTED is among `authored` —
    // the new page is its own nearest agent-authored row — so it is stamped as
    // its creator here, after the commit.
    //
    await stampAuthors(authored, ctx.conversationId);

    // A rename is the call's ONLY write: `titleEditOf` admits a changed title
    // line only when nothing else changed, so the apply above planned nothing
    // and the title is written here, alone. A human flipping the page to theirs
    // since the scope was read gets a 409 (`requireAuthor`, checked under the
    // page row's lock) and nothing written.
    const noteIds = [...authored];
    if (renamedTo !== undefined) {
      await renamePage(scope.pageId, renamedTo, { requireAuthor: "agent" });
      // Renaming the page is writing it: the page is the agent-authored block the
      // rename touched, so it is stamped like any block an edit wrote.
      await stampAuthors([scope.pageId], ctx.conversationId);
      if (!noteIds.includes(scope.pageId)) noteIds.push(scope.pageId);
    }
    // Tags are the page's metadata, not the author's prose, so they are
    // written on ANY page — the one holding the scope root.
    const tagsWritten =
      tagResolution === null
        ? null
        : await writeResolvedPageTags(scope.pageId, tagResolution.tags);
    return jsonResult({
      ...(applySummary(report, noteIds) as object),
      ...(tagsWritten === null
        ? {}
        : {
            tags_set: tagsWritten.names,
            ...(tagsWritten.created.length === 0
              ? {}
              : { tags_created: tagsWritten.created }),
          }),
      replaced: replaceAll ? matches : 1,
      // Said aloud rather than applied silently: the caller's snippet was at
      // another depth than the text it matched (the first match's shift; with
      // replace_all, later matches may sit at other depths).
      ...(shift === null
        ? {}
        : { reindented: { from: shift.from.length, to: shift.to.length } }),
      ...(renamedTo === undefined ? {} : { renamed_to: renamedTo }),
      ...(metaIgnored
        ? {
            page_meta_ignored:
              "<page-meta> is read-only outside its <tags> section: your change to the rest of it was not written",
          }
        : {}),
    });
  },
});

/**
 * Where the length of every rendered page section goes. A client may truncate
 * long server instructions, so the length is what tells whether the global
 * instructions still fit.
 */
const instructionsLog = defineLogSink({
  id: "mcp-page-instructions",
  description:
    "One line per MCP initialize: the conversation and the length of the page-instructions section of the server instructions (page/annotations/agent-access).",
});

/**
 * The page section of the MCP server instructions — what page instructions are,
 * and every global one. Lives beside the three tools because it describes them:
 * the `instructions` plugin owns the data and the delivery record, and stays
 * free of MCP.
 */
export const pageInstructionsSection = Mcp.instructions({
  id: "page-instructions",
  async render({ conversationId }) {
    const section = await renderGlobalSection(conversationId);
    instructionsLog.publish(
      JSON.stringify({ conversationId, length: section.length }),
    );
    return section;
  },
});
