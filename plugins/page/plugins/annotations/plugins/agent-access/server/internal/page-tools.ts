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
  resolveTagNames,
  writeResolvedPageTags,
} from "@plugins/page/plugins/tags/server";
import {
  agentCodeSpanTokens,
  renamePage,
} from "@plugins/page/plugins/editor/server";
import {
  blockAuthorOf,
  dropBlankLinesBesideTags,
  pageBlockHandle,
  unwrapAgentCodeSpans,
  type MarkdownContext,
} from "@plugins/page/plugins/editor/core";
import { recordAgentNotesAuthor } from "@plugins/page/plugins/annotations/plugins/agent-notes/plugins/authorship/server";
import {
  assertInstructionsReceived,
  deliverWithRead,
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
 * The agent-facing face of a page, as the file triple an agent already knows —
 * the HANDLERS, portable (no MCP, no computer): the `read_page` / `edit_page` /
 * `write_agent_note` MCP tools (`machine/internal/mcp-tools.ts`) are thin
 * wrappers over {@link pageTools}, and a host without the computer (a browser
 * demo seeding a page as an agent would) calls the same functions and gets the
 * same result, byte for byte:
 *
 * ```
 * Read   → read_page(block_id)
 * Write  → write_agent_note(block_id, content)
 * Edit   → edit_page(block_id, old_string, new_string, replace_all)
 * ```
 *
 * `page/markdown-apply` is the engine and stays audience-agnostic — it takes a
 * root, a row filter and a boundary predicate, and knows nothing about who
 * anything is for. These three functions are the POLICY over it (see `./policy.ts`),
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

/** Who is calling: the conversation a write is stamped with and instructions are delivered to. */
export interface PageToolCaller {
  conversationId: string;
}

/** What every page tool returns — an MCP tool result's one text part. */
export interface PageToolResult {
  content: [{ type: "text"; text: string }];
}

/** `read_page`'s input, under the MCP tool's own (snake_case) names. */
export interface ReadPageInput {
  block_id: string;
}

/** `write_agent_note`'s input. */
export interface WriteAgentNoteInput {
  block_id: string;
  content: string;
}

/** `edit_page`'s input. `replace_all` is required here: the tool's schema defaults it. */
export interface EditPageInput {
  block_id: string;
  old_string: string;
  new_string: string;
  replace_all: boolean;
}

const jsonResult = (value: unknown): PageToolResult => ({
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

async function readPage(
  { block_id: blockId }: ReadPageInput,
  { conversationId }: PageToolCaller,
): Promise<PageToolResult> {
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
    conversationId,
    pageId: scope.pageId,
    readRootId: blockId,
    body: markdown,
  });
  const text = preamble === "" ? markdown : `${preamble}\n\n${markdown}`;
  return { content: [{ type: "text" as const, text }] };
}

async function writeAgentNote(
  { block_id: blockId, content }: WriteAgentNoteInput,
  { conversationId }: PageToolCaller,
): Promise<PageToolResult> {
  const scope = await loadBlockScope(blockId);
  assertAgentAuthored(scope, blockId);
  // Before anything is planned: a refusal here has written nothing.
  await assertInstructionsReceived({
    tool: "write_agent_note",
    conversationId,
    pageId: scope.pageId,
  });
  // The block set the acceptance predicate resolved, carried out of the hook.
  // `assertAcceptable` returns void by design — its only verdict is throwing —
  // so the answer it computes on the way rides out on a closure rather than
  // being walked a second time here.
  let authored: string[] = [];
  // A blank line the agent put beside a tag is spacing, not an empty
  // paragraph (see `dropBlankLinesBesideTags`). A backticked id the write
  // introduces lands as the id's chip; one already in the card stays as it
  // is, so a `<human>` card echoed back keeps its bytes (see
  // `unwrapAgentCodeSpans`).
  const spaced = agentWrittenText(
    content,
    content.includes("`")
      ? await readBlockAsMarkdown(blockId, { redact: redactHumanAudience })
      : "",
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
  await stampAuthors([blockId, ...authored], conversationId);
  return jsonResult(
    applySummary(report, [blockId, ...authored.filter((id) => id !== blockId)]),
  );
}

async function editPage(
  {
    block_id: blockId,
    old_string: oldString,
    new_string: newString,
    replace_all: replaceAll,
  }: EditPageInput,
  { conversationId }: PageToolCaller,
): Promise<PageToolResult> {
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
    conversationId,
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
  // spacer when a card lands beside it (see `dropBlankLinesBesideTags`). The
  // same holds for a backticked id: one new_string introduces lands as the
  // chip, one carried over from old_string stays code.
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
      agentWrittenText(
        withHeader ? newString : withoutPageMeta(newString),
        oldString,
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
    next = next.slice(0, edit.start) + edit.replacement + next.slice(edit.end);
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
  await stampAuthors(authored, conversationId);

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
    await stampAuthors([scope.pageId], conversationId);
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
}

/**
 * Text an agent WROTE, read the way it means it, before it is spliced and
 * parsed: a blank line beside a tag is spacing (`dropBlankLinesBesideTags`),
 * and a backticked bare id is the id's chip (`unwrapAgentCodeSpans`) — unless
 * the same span is already in `replaced`, the text this write replaces.
 */
function agentWrittenText(text: string, replaced: string): string {
  const { handles } = serverMarkdownContext();
  return unwrapAgentCodeSpans(
    dropBlankLinesBesideTags(text, handles),
    handles,
    agentCodeSpanTokens(),
    replaced,
  );
}

/**
 * The three page tools as plain functions: each takes the MCP tool's input and
 * the caller, and returns exactly what the tool returns — the same text, the
 * same refusals (thrown `HttpError`s), the same authorship stamps.
 */
export const pageTools = {
  read: readPage,
  edit: editPage,
  writeNote: writeAgentNote,
};
