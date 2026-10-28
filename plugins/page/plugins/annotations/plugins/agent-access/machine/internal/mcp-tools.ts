import { z } from "zod";
import { Mcp } from "@plugins/infra/plugins/mcp/server";
import { loadTagVocabularyNames } from "@plugins/page/plugins/tags/server";
import { TAG_COLORS } from "@plugins/page/plugins/tags/core";
import { defineLogSink } from "@plugins/primitives/plugins/log-channels/server";
import { renderGlobalSection } from "../../server/internal/instructions-gate";
import { pageTools } from "../../server/internal/page-tools";

/**
 * The page tools as MCP tools: their names, descriptions and input schemas, each
 * handler a call into {@link pageTools} (`server/internal/page-tools.ts`), which
 * holds the behaviour and stays portable. Here because MCP serves the agents
 * launched on the computer.
 */

export const readPageTool = Mcp.tool({
  name: "read_page",
  description: `Read an equin page — or any block within one — as markdown.

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
  handler: (input, ctx) =>
    pageTools.read(input, { conversationId: ctx.conversationId }),
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

To show a prototype you built (\`proto-…\`), write \`<prototype id="proto-…"/>\` on
a line of its own: it renders as the mock itself, live and interactive in the page.
\`read_page\` shows it back as \`<prototype id="…" title="…"/>\`, \`title\` read-only.

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

An id you write (\`task-…\`, \`att-…\`, \`conv-…\`) becomes its chip, in
backticks or not; read_page then shows it bare.

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
  handler: (input, ctx) =>
    pageTools.writeNote(input, { conversationId: ctx.conversationId }),
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
- An id you write (\`task-…\`, \`att-…\`, \`conv-…\`) becomes its chip, in
  backticks or not; read_page then shows it bare. A backticked id carried over
  unchanged from \`old_string\` stays as it was.
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
  handler: (input, ctx) =>
    pageTools.edit(input, { conversationId: ctx.conversationId }),
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
