// Agent access to a page: what an agent may see, and what it may write.
//
// This file is the executable statement of BOTH halves — the policy this plugin
// adds, and the engine guarantee it inherits from `page/markdown-apply` (whose
// own end-to-end spec moved here with the tools, since the engine has no
// agent-facing surface of its own any more).
//
// Policy:
//  P1. `read_page` is LOSSLESS and REDACTING at once — the prose and every
//      `<agent-inline id="…">` address are there; a `/private` card, its contents
//      and even the substring `private-note` are not.
//  P2. Every refusal fires with a message that names the fix, and — checked on a
//      five-column row snapshot, not on the tool's own report — writes NOTHING.
//  P3. A block INSIDE a private card cannot be read — the id itself is not a
//      bypass.
//  P4. A card MAY nest: an edit whose markdown puts an `<agent-inline>` inside an
//      existing card mints it there and attributes the write to the INNER card.
//      This was a refusal until the rule that carried it over from the dead
//      `append_agent_notes` tool was dropped — see the plugin's CLAUDE.md.
//  P5. A card CREATED by `edit_page` is stamped with the calling conversation
//      (the provenance a human opens from the card's glyph). Every newly minted
//      card, not one known id.
//  P6. **The T3 attack.** An edit that re-indents the page's own prose under an
//      existing `<agent-inline id="…">` is refused. It is a MOVE, not a creation —
//      the text is byte-identical so the aligner preserves the block's id — which
//      is exactly why the acceptance predicate has to test the OLD chain too.
//  P7. A private card survives a PAGE-scoped edit untouched, in all five columns.
//      The tool's report is not proof: a deleted card is simply unmentioned, and
//      a card re-ranked to the end of the page passes any row-existence check.
//  P8. A `<human>` card nested INSIDE an `<agent-inline>` is a hole the agent
//      cannot write: an `edit_page` of a line in it is refused, and so is a
//      `write_agent_note` on the enclosing card that simply leaves it out — which
//      is what "the whole card's contents" makes of an omission. Both checked on
//      the five-column snapshot, because a refusal must write nothing.
//  P9. **An agent page** (`research/2026-09-11-page-agent-pages.md`). A tagless
//      `<agent-page title="…">body</agent-page>` in an `edit_page` mints a real
//      sub-page, named in `created_page_ids`; the parent's `read_page` then shows
//      the pointer `<agent-page id="…" title="…"/>`, and a human's sub-page shows
//      as `<page id="…" title="…"/>`. `read_page` / `edit_page` /
//      `write_agent_note` on the page's own id reach its whole content. The page
//      is stamped with the creating conversation, and carries NO agent-origin
//      marker (the 24h e2e sweep must never see it). An empty agent page a human
//      inserts (`turn-into-page` with `kind: agent-page`) is stamped by its first
//      writer. Every refusal — a pointer given a body or an extra attribute, a
//      pointer claiming a human's page is the agent's, renaming a HUMAN's page
//      through its `# Title` line, a PATCH flipping the marker — leaves both
//      pages' snapshots unchanged.
// P10. **An agent renames its page** by editing the `# Title` line
//      (`research/2026-09-15-page-agent-page-follow-ups.md` §3). The stored
//      title changes, the result says `renamed_to`, the page's content is not
//      touched, and the parent's pointer follows. A formatted title is refused
//      with nothing written. Flipped to the human's with the header toggle's
//      endpoint (`POST /api/blocks/:id/page-kind`), the same rename is refused
//      and so is a body write; flipped back, writes are accepted again.
// P11. **Instructions** (`research/2026-09-17-page-agent-instructions.md`). A
//      Tracks page holding an instructions page, and a Track page beside it:
//      `read_page` on the Track opens with a `<received-instructions>` block
//      carrying the rules, and a second read does not. A conversation that never
//      read them has its `write_agent_note` refused with the rules in the
//      message and nothing written, and the retry goes through. Once the rules
//      are edited, both conversations get them again: the writer is refused
//      once more, and the reader's next read carries them. An MCP `initialize`
//      carries the page-instructions section.
// P12. **Indentation is forgiven by a uniform shift**
//      (`research/2026-09-22-page-edit-page-indent-tolerant-match.md`). A nested
//      line copied WITH its indentation from the page's read, edited through its
//      PARENT's id (whose read holds only what is nested under it, at depth zero
//      — as a `<todo>` card's does), still matches: the result says `reindented`,
//      and the new line lands as the nested line's child. The reverse — copied
//      from the parent's read, edited through the page — works the same way. Text that matches at two depths is refused, writing nothing.
// P-tags. **Page tags** (`research/2026-10-09-page-tags.md`). `read_page`'s header
//      opens with `<tags/>` on an untagged page; `edit_page` replacing it with
//      `<tag name="…"/>` lines writes the page's tags, resolved against the
//      workspace vocabulary (case-insensitive, stored canonically — `tags_set`).
//      An unknown name is refused 400 with the closest name and writes nothing;
//      `new="true" color="…"` creates it (`tags_created`). A tag edit and a
//      content edit in one call write both. `page_meta_ignored` is reported for
//      an edit to another header part, never for a tag-only edit.
//
// Engine, through the notes-only surface:
//  E1. Every prose block on the page keeps its id across a write — which is what
//      keeps its content doc, undo history, backlinks, star and task link
//      attached to it.
//  E2. The edited block's text lands in BOTH owners: its content `Y.Doc` and the
//      `page_blocks.data.text` projection search / backlinks / history read.
//  E3. A browser with the page OPEN converges on the change.
//  E4. **The round trip is a fixed point.** `read_page`'s exact output, fed back
//      as a write, reports `{created:0, deleted:0, moved:0, text_edited:0}` — one
//      call proving the tag round trip, id-pinning and alignment together — and
//      leaves the same five-column snapshot behind.
//
//      Only as strong as the page it runs on: a fixture of plain words passes on
//      any serializer, which is how E4 passed through both round-trip losses it
//      exists to catch. So the prose (`PROSE`) holds one line of each class
//      whose markdown spelling differs from its stored text — a soft line break
//      (`research/2026-09-10-page-soft-break-markdown-round-trip.md`) and a
//      paragraph another block type would claim on parse — and a named
//      precondition checks the live page still has both before E4 runs.
//      Measured with the line-claim escape disabled: the loss surfaces even
//      earlier, as `markdown-apply`'s own round-trip refusal of the FIRST
//      page-rooted edit (naming the row it would drop) — the engine asks this
//      same question before every write. E4 is the assertion that a passing
//      round trip is also a fixed point. A new loss class is one more `PROSE`
//      entry
//      (`research/2026-09-22-page-agent-access-e2e-round-trip-fixture.md`).
//
// Manual only. Requires `./singularity build` first.
// Usage: bun plugins/page/plugins/annotations/plugins/agent-access/e2e/agent-access-verify.ts [--url <deploy>] [--out <path>]
import type { Page } from "playwright";
import {
  agentFetch,
  arg,
  report,
  snap,
  withBrowser,
} from "@plugins/framework/plugins/tooling/plugins/e2e-harness/e2e";
import {
  blockIdOf,
  editableBlocks,
  openBlankPage,
  typeLines,
} from "@plugins/page/plugins/editor/e2e";
import { fetchBlockDocText } from "@plugins/page/plugins/editor-collab/e2e";
import {
  pageBlocks,
  plainOf,
  type Block,
} from "@plugins/page/plugins/editor/core";
import { splitPageMeta } from "@plugins/page/plugins/markdown-apply/core";

const out = arg("out", "/tmp/agent-access");

/** The conversation the MCP calls below are attributed to (P5 reads it back). */
const CONVERSATION = "e2e-agent-access";

/** Set on the page row, so the `# Title` banner is a line worth attacking. */
const TITLE = "Parser notes";
/**
 * One prose line: what its row STORES, and how `read_page` SPELLS it.
 *
 * Both, because for these lines they differ, and each use below compares one of
 * them: a stored row, the rendered editor and the typing take `text`; every
 * `old_string` anchor and every check on the read take `md`. There is
 * deliberately no single string to reach for.
 *
 * The spellings are written out by hand rather than asked of the serializer:
 * this is the independent statement of the contract, and a spelling computed by
 * the code under test would agree with whatever that code does.
 */
interface ProseLine {
  text: string;
  md: string;
}
const PROSE: readonly ProseLine[] = [
  // Shift+Enter inside one paragraph (`typeLines` types a `\n` that way): ONE
  // block whose text holds a soft break. The read spells the break as the two
  // characters `\n`, so the block stays one markdown line.
  { text: "alpha one\nstill alpha", md: "alpha one\\nstill alpha" },
  // Plain on purpose: the card is minted after it, BEFORE E4. An anchor that
  // depends on a spelling would make a lost spelling bail the whole run there,
  // and E4 would never get to say what was lost.
  { text: "bravo two", md: "bravo two" },
  // Typed as prose — only `1. ` is a typing shortcut, so `2. ` stays a
  // paragraph. A numbered list claims this line on parse, so the read escapes it
  // with one leading backslash. T3 below moves it under the card, indented.
  { text: "2. charlie three", md: "\\2. charlie three" },
];
const SECRET = "do not tell the agent";
// What an agent actually writes: a paragraph, a blank line, then a list. Under
// the blank-line dialect that is FOUR blocks — the blank line is an empty
// paragraph, not spacing — and all four land inside the card, so this stays a
// legal write. Keeping the realistic shape is the point: it is what the round
// trip below (E4) has to be a fixed point over.
const NOTE_MD =
  "found two call sites\n\n- one in the parser\n- one in the writer";
const NOTE_FIRST = "found two call sites";
const NOTE_EDITED = "found three call sites";
// The card's STORED type and its markdown TAG differ since the tag became
// `<agent-inline>` (nothing migrated), so both are needed: one to find rows, one
// to read and write the document.
const CARD_TYPE = "agent-note";
const CARD_TAG = "agent-inline";
// An agent-authored page (P9): the tag, and what it is minted with.
const AGENT_PAGE_TAG = "agent-page";
const AGENT_PAGE_TITLE = "Decoder findings";
const AGENT_PAGE_FIRST = "first finding";
const AGENT_PAGE_EDITED = "first finding, confirmed";
const HUMAN_SUBPAGE_TITLE = "Human sub-page";
// The page author answering the agent INSIDE the agent's own card (P8). The
// stored type is `context` and the markdown tag is `human` — the card was
// renamed everywhere except the column value, so both spellings are needed here:
// one to POST the row, one to read the refusal.
const HUMAN_TYPE = "context";
const HUMAN_TAG = "human";
const HUMAN_LINE = "no — the writer is in encode.ts";

const r = report();

/** Record one failure and stop. Used where nothing further is checkable. */
async function bail(name: string, detail: string): Promise<never> {
  r.fail(name, detail);
  return await r.finish();
}

interface ToolCall {
  ok: boolean;
  /** The tool's text content — its result, or the error message it refused with. */
  text: string;
}

/**
 * Call one MCP tool over the HTTP MCP endpoint.
 *
 * Returns the refusal rather than throwing it: half the assertions here are
 * ABOUT refusals, and a refusal that reads as a transport failure would be
 * indistinguishable from the tool not existing.
 */
async function callTool(
  name: string,
  args: unknown,
  conversation: string = CONVERSATION,
): Promise<ToolCall> {
  const res = await agentFetch(`/api/mcp/${conversation}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: { name, arguments: args },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`MCP ${name}: HTTP ${res.status} — ${raw}`);
  // The transport answers with plain JSON (`enableJsonResponse`), but the same
  // endpoint is allowed to answer SSE; accept both rather than depending on
  // which one the SDK picked today.
  const payload =
    raw.startsWith("event:") || raw.startsWith("data:")
      ? raw
          .split("\n")
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice("data:".length).trim())
          .join("")
      : raw;
  const body = JSON.parse(payload) as {
    error?: { message?: string };
    result?: { isError?: boolean; content?: { text?: string }[] };
  };
  if (body.error) return { ok: false, text: body.error.message ?? "error" };
  const text = body.result?.content?.[0]?.text;
  if (text === undefined)
    throw new Error(`MCP ${name}: no text content — ${raw}`);
  return { ok: body.result?.isError !== true, text };
}

/** A tool call that must succeed; its text, or a bail. */
async function mustCall(
  name: string,
  args: unknown,
  conversation: string = CONVERSATION,
): Promise<string> {
  const call = await callTool(name, args, conversation);
  if (!call.ok) return await bail(`${name} succeeds`, call.text);
  return call.text;
}

/**
 * What a write reports it did. `note_ids` are the agent-authored blocks (cards
 * and pages) it was attributed to; `created_page_ids` the pages it minted.
 */
interface ApplySummary {
  note_ids?: string[];
  created?: number;
  deleted?: number;
  moved?: number;
  text_edited?: number;
  created_ids?: string[];
  created_page_ids?: string[];
  /** The page's new title, when an `edit_page` renamed an agent page (P10). */
  renamed_to?: string;
  /** Set when the edit changed the read-only `<page-meta>` header (P1). */
  page_meta_ignored?: string;
  /** Leading-whitespace lengths, when `old_string` matched at another depth (P12). */
  reindented?: { from: number; to: number };
}

/**
 * A read split into its `<page-meta>` header and the document after it. Every
 * `read_page` opens with one, so a missing or malformed header is a failure.
 */
function readParts(read: string): {
  breadcrumb: { id: string; title: string }[];
  backlinks: { id: string; title: string }[];
  attrs: Record<string, string>;
  body: string;
} {
  const split = splitPageMeta(read);
  if (!split.ok || split.meta === null) {
    throw new Error(
      `read_page output opens with no <page-meta> header: ${read}`,
    );
  }
  return { ...split.meta, body: split.rest };
}

/** A write that must succeed, with its summary parsed. */
async function mustWrite(
  name: string,
  args: unknown,
  conversation: string = CONVERSATION,
): Promise<ApplySummary> {
  return JSON.parse(await mustCall(name, args, conversation)) as ApplySummary;
}

/** `{created, deleted, moved, text_edited}` — the four numbers a fixed point zeroes. */
function counts(summary: ApplySummary): Record<string, number | undefined> {
  return {
    created: summary.created,
    deleted: summary.deleted,
    moved: summary.moved,
    text_edited: summary.text_edited,
  };
}

/** The page's rows, straight off the live-state resource endpoint. */
async function fetchBlocks(pageId: string): Promise<Block[]> {
  const res = await agentFetch(
    `/api/resources/${pageBlocks.key}?pageId=${encodeURIComponent(pageId)}`,
  );
  if (!res.ok)
    throw new Error(`${pageBlocks.key} ${pageId}: HTTP ${res.status}`);
  const body = (await res.json()) as { value?: Block[] };
  if (!body.value)
    throw new Error(`${pageBlocks.key} ${pageId}: response carried no value`);
  return body.value;
}

/** A row's projected plain text (`data.text`). */
function rowText(block: Block): string {
  const data = block.data;
  const text =
    data !== null && typeof data === "object"
      ? (data as { text?: unknown }).text
      : undefined;
  return plainOf(text);
}

/**
 * The five columns a write can move a row through: `(id, type, parent_id, rank,
 * data->>'text')`.
 *
 * `(id, text)` — what this spec used to compare — is blind to exactly the
 * failure modes the plan-judged write introduces: a card silently re-parented
 * into the agent's own, or re-ranked to the bottom of the page, survives an
 * id-and-text comparison unchanged. Rank is in here deliberately and is the
 * strictest column: minting a card beside a redacted row is precisely where a
 * hidden row's key would be overwritten.
 */
type Snapshot = Map<string, string>;

async function snapshot(pageId: string): Promise<Snapshot> {
  const rows = await fetchBlocks(pageId);
  return new Map(
    rows.map(
      (b) =>
        [
          b.id,
          `${b.type}|${b.parentId ?? "-"}|${b.rank}|${rowText(b)}`,
        ] as const,
    ),
  );
}

/** Every row that appeared, vanished or changed between two snapshots. */
function snapshotDiff(before: Snapshot, after: Snapshot): string[] {
  const lines: string[] = [];
  for (const [id, row] of before) {
    const now = after.get(id);
    if (now === undefined) lines.push(`-${id} ${row}`);
    else if (now !== row) lines.push(`~${id} ${row} => ${now}`);
  }
  for (const [id, row] of after)
    if (!before.has(id)) lines.push(`+${id} ${row}`);
  return lines;
}

/** Set the page's own title, so the `# Title` banner is not an empty line. */
async function setPageTitle(
  page: Page,
  pageId: string,
  title: string,
): Promise<void> {
  await page.evaluate(
    async ({ id, value }) => {
      const res = await fetch(`/api/blocks/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ data: { title: value, icon: null } }),
      });
      if (!res.ok)
        throw new Error(`PATCH /api/blocks ${res.status}: ${await res.text()}`);
    },
    { id: pageId, value: title },
  );
}

/** Seed a `/private` card holding one line, through the write boundary. */
async function seedPrivateCard(
  page: Page,
  pageId: string,
  secret: string,
): Promise<{ card: string; child: string }> {
  return page.evaluate(
    async ({ parent, line }) => {
      const post = async (body: unknown): Promise<{ id: string }> => {
        const res = await fetch("/api/blocks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok)
          throw new Error(
            `POST /api/blocks ${res.status}: ${await res.text()}`,
          );
        return (await res.json()) as { id: string };
      };
      const card = await post({
        parentId: parent,
        type: "private-note",
        data: {},
      });
      const child = await post({
        parentId: card.id,
        type: "text",
        data: { text: [{ text: line }] },
      });
      return { card: card.id, child: child.id };
    },
    { parent: pageId, line: secret },
  );
}

/**
 * Seed a `<human>` card holding one line, through the write boundary, UNDER the
 * agent's own card.
 *
 * Through the browser's POST rather than through a tool, because no agent tool
 * can make one — which is itself half of what P8 asserts.
 */
async function seedHumanCard(
  page: Page,
  parentId: string,
  line: string,
): Promise<{ card: string; child: string }> {
  return page.evaluate(
    async ({ parent, type, text }) => {
      const post = async (body: unknown): Promise<{ id: string }> => {
        const res = await fetch("/api/blocks", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok)
          throw new Error(
            `POST /api/blocks ${res.status}: ${await res.text()}`,
          );
        return (await res.json()) as { id: string };
      };
      const card = await post({ parentId: parent, type, data: {} });
      const child = await post({
        parentId: card.id,
        type: "text",
        data: { text: [{ text }] },
      });
      return { card: card.id, child: child.id };
    },
    { parent: parentId, type: HUMAN_TYPE, text: line },
  );
}

/** The conversations recorded as authors of one agent-authored block (card or page). */
async function fetchAuthors(blockId: string): Promise<string[]> {
  const res = await agentFetch(
    `/api/resources/agent-notes-authors?blockId=${encodeURIComponent(blockId)}`,
  );
  if (!res.ok)
    throw new Error(`agent-notes-authors ${blockId}: HTTP ${res.status}`);
  const body = (await res.json()) as { value?: { conversationId: string }[] };
  return (body.value ?? []).map((a) => a.conversationId);
}

/**
 * Seed a SUB-PAGE of `parentId` the way a human makes one: a line, turned into a
 * page in place (`POST /api/blocks/:id/turn-into-page`). `author: "agent"` is the
 * `/agent-page` insert — an empty page a human made for an agent to fill.
 *
 * Through the browser rather than a tool: no agent tool mints a HUMAN's page,
 * and the empty agent page is by definition the one no agent wrote yet.
 */
async function seedSubPage(
  page: Page,
  parentId: string,
  title: string,
  author?: "agent",
): Promise<string> {
  return page.evaluate(
    async ({ parent, name, who }) => {
      const call = async (
        url: string,
        body: unknown,
      ): Promise<{ id: string }> => {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok)
          throw new Error(`POST ${url} ${res.status}: ${await res.text()}`);
        return (await res.json()) as { id: string };
      };
      const line = await call("/api/blocks", {
        parentId: parent,
        type: "text",
        data: { text: [] },
      });
      await call(`/api/blocks/${line.id}/turn-into-page`, {
        title: name,
        seedChild: { type: "text", data: { text: [] } },
        ...(who === undefined ? {} : { kind: { kind: "agent-page" } }),
      });
      return line.id;
    },
    { parent: parentId, name: title, who: author },
  );
}

/** `PATCH /api/blocks/:id` from the browser; the HTTP status it answered. */
async function patchBlockStatus(
  page: Page,
  blockId: string,
  body: unknown,
): Promise<number> {
  return page.evaluate(
    async ({ id, payload }) =>
      (
        await fetch(`/api/blocks/${id}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(payload),
        })
      ).status,
    { id: blockId, payload: body },
  );
}

/**
 * `POST /api/blocks/:id/page-kind` from the browser — the page header's
 * agent-page toggle, and the one way a page's author changes after it is born.
 * The HTTP status it answered.
 *
 * Through the browser for the same reason as the seeds above: no agent tool
 * exposes this operation, so only the human flips a page.
 */
async function setPageAuthorStatus(
  page: Page,
  pageId: string,
  author: "agent" | "human",
): Promise<number> {
  return page.evaluate(
    async ({ id, who }) =>
      (
        await fetch(`/api/blocks/${id}/page-kind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: { kind: who === "agent" ? "agent-page" : "page" },
          }),
        })
      ).status,
    { id: pageId, who: author },
  );
}

/**
 * Make a page an instructions page (not global) through the page header's kind
 * control. The HTTP status it answered.
 */
async function makeInstructionsPage(
  page: Page,
  pageId: string,
): Promise<number> {
  return page.evaluate(
    async (id) =>
      (
        await fetch(`/api/blocks/${id}/page-kind`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            kind: { kind: "instructions", global: false },
          }),
        })
      ).status,
    pageId,
  );
}

/** Add one text line at the end of a page (or block), through the write boundary. */
async function appendLine(
  page: Page,
  parentId: string,
  line: string,
): Promise<void> {
  await page.evaluate(
    async ({ parent, text }) => {
      const res = await fetch("/api/blocks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          parentId: parent,
          type: "text",
          data: { text: [{ text }] },
        }),
      });
      if (!res.ok)
        throw new Error(`POST /api/blocks ${res.status}: ${await res.text()}`);
    },
    { parent: parentId, text: line },
  );
}

/** The `instructions` string of an MCP `initialize` result for one conversation. */
async function initializeInstructions(conversation: string): Promise<string> {
  const res = await agentFetch(`/api/mcp/${conversation}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agent-access-verify", version: "0.0.0" },
      },
    }),
  });
  const raw = await res.text();
  if (!res.ok) throw new Error(`MCP initialize: HTTP ${res.status} — ${raw}`);
  const body = JSON.parse(raw) as { result?: { instructions?: string } };
  return body.result?.instructions ?? "";
}

/** A page row's stored `data.title` and `data.author`, read off its parent's rows. */
async function pageRowFacts(
  parentPageId: string,
  pageId: string,
): Promise<{ title?: string; author?: string } | undefined> {
  const row = (await fetchBlocks(parentPageId)).find((b) => b.id === pageId);
  return row?.data as { title?: string; author?: string } | undefined;
}

/**
 * The page ids `apps/pages/agent-origin` has marked as e2e debris (its 24h sweep
 * trashes them). An agent-authored page must never be among them.
 *
 * Reads the whole `pages-origin.all` marker set (an `all` collection, no
 * params); a row is `{ blockId, source, createdAt }`, keyed on `blockId` (the
 * marked page's id).
 */
async function fetchAgentOriginPageIds(): Promise<string[]> {
  const res = await agentFetch("/api/resources/pages-origin.all");
  if (!res.ok) throw new Error(`pages-origin.all: HTTP ${res.status}`);
  const body = (await res.json()) as { value?: { blockId?: unknown }[] };
  if (!body.value)
    throw new Error("pages-origin.all: response carried no value");
  return body.value.map((row) => {
    // Checked, so a renamed key fails the run instead of mapping every row to
    // `undefined` and passing the "not marked" check vacuously.
    if (typeof row.blockId !== "string") {
      throw new Error(
        `pages-origin.all: row without a blockId: ${JSON.stringify(row)}`,
      );
    }
    return row.blockId;
  });
}

await withBrowser(async (h) => {
  const { page } = await h.session({ label: "reader" });
  const { pageId } = await openBlankPage(page, { settleMs: 2500 });

  // Ordinary paragraphs, typed like a human so their docs are real
  // browser-authored CRDT state (not a server seed) — the soft break included.
  await typeLines(
    page,
    PROSE.map((p) => p.text),
  );
  // Long enough for the ~300ms doc flush AND the ~1s data.text projection.
  await page.waitForTimeout(2500);

  const blocks = editableBlocks(page);
  const proseIds: string[] = [];
  for (let i = 0; i < PROSE.length; i++)
    proseIds.push(await blockIdOf(blocks.nth(i)));
  r.ok(
    `${PROSE.length} prose blocks typed`,
    new Set(proseIds).size === PROSE.length,
    JSON.stringify(proseIds),
  );
  // The fixture is what it claims to be: one row per line, each holding exactly
  // its text — the soft break as a `\n` INSIDE one row, not a second row.
  const typedRows = await fetchBlocks(pageId);
  r.ok(
    "fixture: every prose row stores exactly its line's text",
    proseIds.every((id, i) => {
      const row = typedRows.find((b) => b.id === id);
      return row !== undefined && rowText(row) === PROSE[i]!.text;
    }),
    JSON.stringify(
      proseIds.map((id) => {
        const row = typedRows.find((b) => b.id === id);
        return row ? rowText(row) : null;
      }),
    ),
  );

  await setPageTitle(page, pageId, TITLE);
  const priv = await seedPrivateCard(page, pageId, SECRET).catch(
    (err: unknown): Promise<never> =>
      bail(
        "seed: a /private card posts through the write boundary",
        `${err instanceof Error ? err.message : String(err)} — nothing below is checkable`,
      ),
  );
  await page.reload({ waitUntil: "domcontentloaded" });
  await page.waitForTimeout(2500);

  // --- P4 (creation) / P5 / P7. a tagless <agent-note> mints a card ----------
  // The ONLY way an agent adds anything now: there is no append tool, so the tag
  // in the document is the create.
  const beforeCreate = await snapshot(pageId);
  const created = await mustWrite("edit_page", {
    block_id: pageId,
    old_string: PROSE[1]!.md,
    // Two `\n`: the blank line agents put around a card they insert. It touches
    // the card's open tag, so it is spacing — not an empty paragraph at ROOT,
    // outside every card, which the notes-only rule would refuse.
    new_string: `${PROSE[1]!.md}\n\n<${CARD_TAG}>\n${NOTE_MD}\n</${CARD_TAG}>`,
  });
  const noteId = created.note_ids?.[0];
  if (noteId === undefined) {
    return await bail(
      "edit_page reports the card it minted",
      JSON.stringify(created),
    );
  }

  const rowsAfterCreate = await fetchBlocks(pageId);
  const card = rowsAfterCreate.find((b) => b.id === noteId);
  r.ok(
    `a tagless <${CARD_TAG}> minted a card under the page`,
    card?.type === CARD_TYPE && card.parentId === pageId,
    JSON.stringify(card ?? null),
  );
  // Four children, not three: the blank line inside `NOTE_MD` is an empty
  // paragraph. Exactly one of them is empty — asserted rather than counted, so a
  // fourth block appearing for some OTHER reason still fails this.
  const cardChildren = rowsAfterCreate.filter((b) => b.parentId === noteId);
  r.ok(
    "the markdown became the card's CHILDREN (not a nested card), blank line included",
    cardChildren.length === 4 &&
      cardChildren.filter((b) => rowText(b) === "").length === 1 &&
      rowsAfterCreate.every((b) => b.id === noteId || b.type !== CARD_TYPE),
    JSON.stringify(cardChildren.map((b) => [b.type, rowText(b)])),
  );
  r.ok(
    "the create touched no prose block — every one is still there",
    proseIds.every((id) => rowsAfterCreate.some((b) => b.id === id)),
    JSON.stringify(proseIds),
  );

  // P5, retargeted: the stamp lands on a card MINTED by this write, not on an id
  // the tool was handed. That is the new code path — every newly minted card is
  // resolved out of the plan and stamped after the patch commits.
  const authors = await fetchAuthors(noteId);
  r.ok(
    "P5: the minted card is stamped with the calling conversation",
    authors.includes(CONVERSATION),
    JSON.stringify(authors),
  );

  // P7. The private card is not in the document this edit was written against,
  // so nothing in the plan may have moved it — including its RANK, which is the
  // column a "the row still exists" check cannot see.
  const afterCreate = await snapshot(pageId);
  r.ok(
    "P7: the private card and its child survive a page-scoped edit in all five columns",
    beforeCreate.get(priv.card) !== undefined &&
      beforeCreate.get(priv.card) === afterCreate.get(priv.card) &&
      beforeCreate.get(priv.child) !== undefined &&
      beforeCreate.get(priv.child) === afterCreate.get(priv.child),
    JSON.stringify({
      card: [beforeCreate.get(priv.card), afterCreate.get(priv.card)],
      child: [beforeCreate.get(priv.child), afterCreate.get(priv.child)],
    }),
  );
  r.ok(
    "P7: the edit deleted nothing anywhere on the page",
    snapshotDiff(beforeCreate, afterCreate).every(
      (line) => !line.startsWith("-"),
    ),
    JSON.stringify(snapshotDiff(beforeCreate, afterCreate)),
  );

  // --- P1. lossless AND redacting, in one output ----------------------------
  const markdown = await mustCall("read_page", { block_id: pageId });
  // A WHOLE line each, not a substring: a soft break fanned out into two lines,
  // or a claimed line whose escape was dropped, still contains every word.
  const markdownLines = markdown.split("\n");
  r.ok(
    "P1: read_page returns the page's prose, one markdown line per block, and its title banner",
    PROSE.every((p) => markdownLines.includes(p.md)) &&
      readParts(markdown).body.startsWith(`# ${TITLE}`),
    JSON.stringify(markdown),
  );
  {
    const meta = readParts(markdown);
    r.ok(
      "P1: read_page opens with a <page-meta> header: the human's page kind, the breadcrumb ends at the page, no backlinks to a fresh page, times to the minute",
      meta.attrs.kind === "page" &&
        meta.breadcrumb.at(-1)?.id === pageId &&
        meta.breadcrumb.at(-1)?.title === TITLE &&
        meta.backlinks.length === 0 &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/.test(meta.attrs.created ?? "") &&
        /^\d{4}-\d\d-\d\dT\d\d:\d\dZ$/.test(meta.attrs.edited ?? ""),
      JSON.stringify(meta),
    );
    const scoped = readParts(await mustCall("read_page", { block_id: noteId }));
    r.ok(
      "P1: a block-scoped read's header names the page holding it",
      scoped.breadcrumb.at(-1)?.id === pageId && !scoped.body.startsWith("# "),
      JSON.stringify(scoped),
    );
    const metaEdit = await mustWrite("edit_page", {
      block_id: pageId,
      old_string: `edited="${meta.attrs.edited}"`,
      new_string: 'edited="1999-01-01T00:00Z"',
    });
    r.ok(
      "P1: an edit of the <page-meta> header writes nothing, and says it was ignored",
      metaEdit.page_meta_ignored !== undefined &&
        Object.values(counts(metaEdit)).every((n) => n === 0),
      JSON.stringify(metaEdit),
    );
  }
  r.ok(
    "P1: read_page emits the card's id as an address",
    markdown.includes(`<${CARD_TAG} id="${noteId}">`),
    JSON.stringify(markdown),
  );
  r.ok(
    "P1: read_page omits the private card, its contents AND its tag",
    !markdown.includes(SECRET) && !markdown.includes("private-note"),
    JSON.stringify(markdown),
  );

  // --- P3. naming a block inside the card is not a way around that -----------
  for (const [label, id] of [
    ["the card itself", priv.card],
    ["a block inside it", priv.child],
  ] as const) {
    const refused = await callTool("read_page", { block_id: id });
    r.ok(
      `P3: read_page refuses ${label}`,
      !refused.ok && /withheld from agents/.test(refused.text),
      refused.text,
    );
  }

  // --- E4. the round trip is a fixed point ----------------------------------
  // Precondition, from the LIVE page rather than from `PROSE`: there is
  // something for the round trip to lose. Without it, E4 passes on a serializer
  // that drops every escape — which is how it once passed through both losses.
  const e4Rows = await fetchBlocks(pageId);
  const e4Prose = proseIds.map((id) => {
    const row = e4Rows.find((b) => b.id === id);
    return row === undefined ? null : rowText(row);
  });
  r.ok(
    "E4 precondition: the page holds a soft break inside one row, and a read line that opens with an escape",
    e4Prose.some((text) => text?.includes("\n") === true) &&
      markdownLines.some((line) => line.startsWith("\\")),
    JSON.stringify({ rows: e4Prose, markdown }),
  );
  // `read_page`'s ENTIRE output goes back in as `old_string`, replaced by itself
  // plus one trailing newline — the smallest change the tool's "old and new must
  // differ" contract accepts, and one a markdown parse cannot see. So what is
  // planned is the read's own document, and every zero below is the tag round
  // trip, the id pinning and the alignment all agreeing at once.
  const beforeRoundTrip = await snapshot(pageId);
  const roundTrip = await mustWrite("edit_page", {
    block_id: pageId,
    old_string: markdown,
    new_string: `${markdown}\n`,
  });
  r.eq(
    "E4: feeding read_page's output back writes nothing",
    counts(roundTrip),
    {
      created: 0,
      deleted: 0,
      moved: 0,
      text_edited: 0,
    },
  );
  const afterRoundTrip = await snapshot(pageId);
  r.ok(
    "E4: and the five-column snapshot is byte-identical",
    snapshotDiff(beforeRoundTrip, afterRoundTrip).length === 0,
    JSON.stringify(snapshotDiff(beforeRoundTrip, afterRoundTrip)),
  );

  // The card-scoped half of the same law: `read_page(card)` is exactly what
  // `write_agent_note(card)` takes, so re-writing it changes nothing either.
  const cardMarkdown = await mustCall("read_page", { block_id: noteId });
  const rewrite = await mustWrite("write_agent_note", {
    block_id: noteId,
    content: cardMarkdown,
  });
  r.eq(
    "E4: write_agent_note of the card's own read is a fixed point too",
    counts(rewrite),
    {
      created: 0,
      deleted: 0,
      moved: 0,
      text_edited: 0,
    },
  );

  // --- P2 / P4 / P6. everything an agent may NOT do -------------------------
  // Every entry is an EDIT the tools accept the shape of; what refuses it is the
  // acceptance predicate, the type rule, or the read door.
  // The prose line that FOLLOWS the card, and the same line moved inside it —
  // written the way the serializer writes a card's children (one two-space
  // indent), so the parse reads it as a child rather than as a stray line.
  const closeThenProse = `</${CARD_TAG}>\n${PROSE[2]!.md}`;
  const proseIntoCard = `  ${PROSE[2]!.md}\n</${CARD_TAG}>`;
  r.ok(
    "the T3 attack is expressible against the document as read",
    markdown.includes(closeThenProse),
    JSON.stringify(markdown),
  );

  const refusals: [
    name: string,
    tool: string,
    args: unknown,
    expect: RegExp,
  ][] = [
    [
      "P6/T3: re-indenting the page's prose INTO the card (a move, id preserved)",
      "edit_page",
      {
        block_id: pageId,
        old_string: closeThenProse,
        new_string: proseIntoCard,
      },
      /did not COME from inside/,
    ],
    [
      "P2: rewriting a prose block",
      "edit_page",
      { block_id: pageId, old_string: PROSE[0]!.md, new_string: "hijacked" },
      /outside every agent-authored block/,
    ],
    [
      "P2: minting a private card inside its own",
      "edit_page",
      {
        block_id: pageId,
        old_string: NOTE_FIRST,
        new_string: `${NOTE_FIRST}\n<private-note>\nsneaky\n</private-note>`,
      },
      /creates a <private-note> card/,
    ],
    [
      "P2: claiming an id that names no card",
      "edit_page",
      {
        block_id: pageId,
        old_string: `<${CARD_TAG} id="${noteId}">`,
        new_string: `<${CARD_TAG} id="block-does-not-exist">`,
      },
      /names no addressable/,
    ],
    [
      "P2: rewriting the page's title banner",
      "edit_page",
      { block_id: pageId, old_string: `# ${TITLE}`, new_string: "# Hijacked" },
      /TITLE and not a block/,
    ],
    [
      "P3: scoping an edit to a block inside the private card",
      "edit_page",
      { block_id: priv.child, old_string: SECRET, new_string: "hijacked" },
      /withheld from agents/,
    ],
    [
      "P2: old_string that is not in the document",
      "edit_page",
      { block_id: pageId, old_string: SECRET, new_string: "hijacked" },
      /was not found/,
    ],
    [
      "P2: an edit that asks for no change",
      "edit_page",
      { block_id: pageId, old_string: NOTE_FIRST, new_string: NOTE_FIRST },
      /identical/,
    ],
    [
      "P2: write_agent_note at a prose block",
      "write_agent_note",
      { block_id: proseIds[1]!, content: "hijacked" },
      /not agent-authored/,
    ],
    [
      "P2: write_agent_note at the page",
      "write_agent_note",
      { block_id: pageId, content: "hijacked" },
      /its author wrote, not agent-authored/,
    ],
    [
      "P2: write_agent_note at the private card",
      "write_agent_note",
      { block_id: priv.card, content: "hijacked" },
      /not agent-authored/,
    ],
  ];

  const beforeRefusals = await snapshot(pageId);
  for (const [name, tool, args, expect] of refusals) {
    const refused = await callTool(tool, args);
    r.ok(
      `refused: ${name}`,
      !refused.ok && expect.test(refused.text),
      refused.text,
    );
  }
  const afterRefusals = await snapshot(pageId);
  r.ok(
    "P2: no refusal wrote anything — set-equality on all five columns",
    snapshotDiff(beforeRefusals, afterRefusals).length === 0,
    JSON.stringify(snapshotDiff(beforeRefusals, afterRefusals)),
  );

  // --- E1 / E2. a real write into the card, and what it may touch -----------
  const noteChildId = rowsAfterCreate.find(
    (b) => b.parentId === noteId && rowText(b) === NOTE_FIRST,
  )?.id;
  if (noteChildId === undefined) {
    return await bail(
      "the minted card has an addressable first line",
      JSON.stringify(NOTE_MD),
    );
  }

  const edit = await mustWrite("edit_page", {
    block_id: pageId,
    old_string: NOTE_FIRST,
    new_string: NOTE_EDITED,
  });
  r.eq(
    "a page-scoped edit INSIDE the card is exactly one text edit",
    counts(edit),
    {
      created: 0,
      deleted: 0,
      moved: 0,
      text_edited: 1,
    },
  );
  r.ok(
    "the edit is attributed to the card it landed in",
    (edit.note_ids ?? []).includes(noteId),
    JSON.stringify(edit.note_ids ?? null),
  );

  // Let the doc-update push reach the open tab and the projection settle.
  await page.waitForTimeout(2500);

  const rowsAfterEdit = await fetchBlocks(pageId);
  r.ok(
    "E1: every prose block kept its id AND its text",
    proseIds.every((id, i) => {
      const row = rowsAfterEdit.find((b) => b.id === id);
      return row !== undefined && rowText(row) === PROSE[i]!.text;
    }),
    JSON.stringify(rowsAfterEdit.map((b) => [b.id, b.type, rowText(b)])),
  );
  const finalSnapshot = await snapshot(pageId);
  r.ok(
    "E1: the private card and its contents are untouched, in all five columns",
    beforeRefusals.get(priv.card) === finalSnapshot.get(priv.card) &&
      beforeRefusals.get(priv.child) === finalSnapshot.get(priv.child),
    JSON.stringify([
      finalSnapshot.get(priv.card),
      finalSnapshot.get(priv.child),
    ]),
  );

  const docAfter = await fetchBlockDocText(noteChildId);
  r.ok(
    "E2: the content doc holds the edit",
    docAfter === NOTE_EDITED,
    JSON.stringify(docAfter),
  );
  const editedRow = rowsAfterEdit.find((b) => b.id === noteChildId);
  r.ok(
    "E2: data.text was projected from the doc",
    editedRow !== undefined && rowText(editedRow) === NOTE_EDITED,
    JSON.stringify(editedRow ? rowText(editedRow) : null),
  );

  // --- E3. the open editor converged ---------------------------------------
  // By block id, not by position: the card sits between `bravo` and `charlie`,
  // so the editable-line order is no longer the prose order. Compared with the
  // TEXT: the soft break renders as a `<br>`, which `innerText` reads as `\n`.
  const rendered: string[] = [];
  for (const id of proseIds) {
    rendered.push(
      (await page.locator(`[data-block-id="${id}"]`).first().innerText())
        .replace(/ /g, " ")
        .trim(),
    );
  }
  r.ok(
    "E3: the already-open editor still shows the prose it had",
    JSON.stringify(rendered) === JSON.stringify(PROSE.map((p) => p.text)),
    JSON.stringify(rendered),
  );
  r.ok(
    "E3: the open editor shows the edited note",
    (
      await page.locator(`[data-block-id="${noteChildId}"]`).first().innerText()
    ).includes(NOTE_EDITED),
    NOTE_EDITED,
  );

  // --- P4. a card inside a card is minted, and stamped as its own ----------
  // Same edit shape that used to be refused. What it pins is the ATTRIBUTION,
  // which is the only thing nesting changes: the write resolves to the INNER
  // card, not to the one holding it.
  // INDENTED to the card's own children. `read_page` writes a card's children one
  // two-space indent in, so a tag spliced in at column 0 sits SHALLOWER than the
  // lines below it and legitimately adopts them — the same thing any container
  // does to more-indented lines under it. That is not nesting, it is a re-parent,
  // and asserting `moved` alone would not tell the two apart: the counts below are
  // paired with the sibling check, which is what actually distinguishes them.
  const nested = await mustWrite("edit_page", {
    block_id: pageId,
    old_string: NOTE_EDITED,
    new_string: `${NOTE_EDITED}\n  <${CARD_TAG}>\n    nested\n  </${CARD_TAG}>`,
  });
  r.eq(
    "P4: nesting a card mints the card and its line, and moves nothing",
    counts(nested),
    {
      created: 2,
      deleted: 0,
      moved: 0,
      text_edited: 0,
    },
  );
  const rowsAfterNest = await fetchBlocks(pageId);
  const innerCard = rowsAfterNest.find(
    (b) => b.type === CARD_TYPE && b.parentId === noteId,
  );
  // The card's original children are still ITS children. Without this, a write
  // that swallowed them into the new card passes every other assertion here.
  r.ok(
    "P4: the outer card kept its own children — the new card adopted none of them",
    innerCard !== undefined &&
      rowsAfterNest.filter((b) => b.parentId === innerCard.id).length === 1 &&
      rowsAfterNest.filter((b) => b.parentId === noteId).length === 5,
    JSON.stringify(
      rowsAfterNest
        .filter((b) => b.parentId === noteId || b.parentId === innerCard?.id)
        .map((b) => [b.parentId === noteId ? "outer" : "inner", rowText(b)]),
    ),
  );
  r.ok(
    "P4: the new card sits INSIDE the existing one",
    innerCard !== undefined,
    JSON.stringify(rowsAfterNest.map((b) => [b.id, b.type, b.parentId])),
  );
  r.ok(
    "P4: the write is attributed to the inner card alone",
    innerCard !== undefined &&
      JSON.stringify(nested.note_ids ?? []) === JSON.stringify([innerCard.id]),
    JSON.stringify(nested.note_ids ?? null),
  );

  // --- P8. the author's answer, nested inside the agent's own card ----------
  // The card the agent may READ and may not WRITE. It is the one shape the old
  // "an edit whose diff stays inside a card may rewrite that card wholesale"
  // bound could not survive, so both refusals below are the point of the
  // feature rather than an edge case of it.
  const answer = await seedHumanCard(page, noteId, HUMAN_LINE).catch(
    (err: unknown): Promise<never> =>
      bail(
        `seed: a <${HUMAN_TAG}> card posts inside the agent's card`,
        `${err instanceof Error ? err.message : String(err)} — P8 is not checkable`,
      ),
  );
  await page.waitForTimeout(1000);

  const nestedMarkdown = await mustCall("read_page", { block_id: pageId });
  r.ok(
    `P8: read_page shows the nested <${HUMAN_TAG}> card, with its id as an address`,
    nestedMarkdown.includes(`<${HUMAN_TAG} id="${answer.card}">`) &&
      nestedMarkdown.includes(HUMAN_LINE),
    JSON.stringify(nestedMarkdown),
  );

  const beforeHuman = await snapshot(pageId);
  const humanRefusals: [
    name: string,
    tool: string,
    args: unknown,
    expect: RegExp,
  ][] = [
    [
      `P8: editing a line inside the nested <${HUMAN_TAG}> card`,
      "edit_page",
      {
        block_id: pageId,
        old_string: HUMAN_LINE,
        new_string: "the writer is in decode.ts",
      },
      new RegExp(`sits inside <${HUMAN_TAG}> card ${answer.card}`),
    ],
    [
      `P8: a write_agent_note that OMITS the nested <${HUMAN_TAG}> card`,
      // `content` is the card's WHOLE new contents, so leaving the nested card
      // out is not an omission the applier forgives — it plans its deletion, and
      // the whole write is refused with nothing written.
      "write_agent_note",
      { block_id: noteId, content: NOTE_EDITED },
      new RegExp(`<${HUMAN_TAG}> card`),
    ],
    [
      `P8: minting a <${HUMAN_TAG}> card inside the agent's own`,
      "edit_page",
      {
        block_id: pageId,
        old_string: NOTE_EDITED,
        new_string: `${NOTE_EDITED}\n<${HUMAN_TAG}>\nspeaking for you\n</${HUMAN_TAG}>`,
      },
      new RegExp(`creates a <${HUMAN_TAG}> card`),
    ],
  ];
  for (const [name, tool, args, expect] of humanRefusals) {
    const refused = await callTool(tool, args);
    r.ok(
      `refused: ${name}`,
      !refused.ok && expect.test(refused.text),
      refused.text,
    );
  }
  const afterHuman = await snapshot(pageId);
  r.ok(
    "P8: none of those wrote anything — set-equality on all five columns",
    snapshotDiff(beforeHuman, afterHuman).length === 0,
    JSON.stringify(snapshotDiff(beforeHuman, afterHuman)),
  );

  // The other half of the same law: echoed back, the card is a fixed point, so
  // the rule costs an honest write nothing.
  const cardWithAnswer = await mustCall("read_page", { block_id: noteId });
  const echoed = await mustWrite("write_agent_note", {
    block_id: noteId,
    content: cardWithAnswer,
  });
  r.eq(
    `P8: write_agent_note that echoes the <${HUMAN_TAG}> card back writes nothing`,
    counts(echoed),
    { created: 0, deleted: 0, moved: 0, text_edited: 0 },
  );
  const afterEcho = await snapshot(pageId);
  r.ok(
    "P8: and the card kept its row id, parent and rank",
    beforeHuman.get(answer.card) === afterEcho.get(answer.card) &&
      beforeHuman.get(answer.child) === afterEcho.get(answer.child),
    JSON.stringify([afterEcho.get(answer.card), afterEcho.get(answer.child)]),
  );

  // --- P9. an agent page: minted by a tag, written by its own id --------------
  const humanSubPage = await seedSubPage(
    page,
    pageId,
    HUMAN_SUBPAGE_TITLE,
  ).catch((err: unknown): Promise<never> =>
    bail(
      "seed: a human's sub-page through turn-into-page",
      `${err instanceof Error ? err.message : String(err)} — P9 is not checkable`,
    ),
  );
  await page.waitForTimeout(1000);

  const beforeMint = await snapshot(pageId);
  const minted = await mustWrite("edit_page", {
    block_id: pageId,
    old_string: PROSE[0]!.md,
    new_string:
      `${PROSE[0]!.md}\n<${AGENT_PAGE_TAG} title="${AGENT_PAGE_TITLE}">\n` +
      `  ${AGENT_PAGE_FIRST}\n  - checked decode.ts\n</${AGENT_PAGE_TAG}>`,
  });
  const agentPageId = minted.created_page_ids?.[0];
  if (agentPageId === undefined || minted.created_page_ids?.length !== 1) {
    return await bail(
      "P9: edit_page names the ONE page it minted in created_page_ids",
      JSON.stringify(minted),
    );
  }
  r.ok(
    "P9: the page and its two body lines were created, and nothing else",
    minted.created === 3 &&
      minted.deleted === 0 &&
      (minted.created_ids ?? []).includes(agentPageId),
    JSON.stringify(minted),
  );
  r.ok(
    "P9: the write is attributed to the new page, not to anything around it",
    JSON.stringify(minted.note_ids ?? []) === JSON.stringify([agentPageId]),
    JSON.stringify(minted.note_ids ?? null),
  );

  const parentAfterMint = await fetchBlocks(pageId);
  const pageRow = parentAfterMint.find((b) => b.id === agentPageId);
  r.ok(
    "P9: the new page is a FOLDED sub-page row of the page, marked agent-authored",
    pageRow !== undefined &&
      pageRow.type === "page" &&
      pageRow.parentId === pageId &&
      !pageRow.expanded &&
      (pageRow.data as { author?: string }).author === "agent",
    JSON.stringify(pageRow ?? null),
  );
  // The parent gained exactly one row — the page — and no line of it moved: the
  // body lives in the NEW page's partition, not in this page's rows.
  const mintDiff = snapshotDiff(beforeMint, await snapshot(pageId));
  r.ok(
    "P9: the parent page gained the page row and nothing else changed",
    mintDiff.length === 1 && mintDiff[0]!.startsWith(`+${agentPageId}`),
    JSON.stringify(mintDiff),
  );

  const parentMarkdown = await mustCall("read_page", { block_id: pageId });
  r.ok(
    "P9: read_page on the parent shows the POINTER, with its title",
    parentMarkdown.includes(
      `<${AGENT_PAGE_TAG} id="${agentPageId}" title="${AGENT_PAGE_TITLE}"/>`,
    ) && !parentMarkdown.includes(AGENT_PAGE_FIRST),
    JSON.stringify(parentMarkdown),
  );
  r.ok(
    "P9: …and a human's sub-page as `<page id title/>` — every page pointer is titled",
    parentMarkdown.includes(
      `<page id="${humanSubPage}" title="${HUMAN_SUBPAGE_TITLE}"/>`,
    ),
    JSON.stringify(parentMarkdown),
  );

  const pageMarkdown = await mustCall("read_page", { block_id: agentPageId });
  r.ok(
    'P9: read_page on the page\'s own id is its whole content, title banner first, its header saying kind="agent-page"',
    readParts(pageMarkdown).attrs.kind === AGENT_PAGE_TAG &&
      readParts(pageMarkdown).body.startsWith(`# ${AGENT_PAGE_TITLE}`) &&
      readParts(pageMarkdown)
        .breadcrumb.slice(-2)
        .map((c) => c.id)
        .join() === [pageId, agentPageId].join() &&
      pageMarkdown.includes(AGENT_PAGE_FIRST) &&
      pageMarkdown.includes("checked decode.ts"),
    JSON.stringify(pageMarkdown),
  );

  const creators = await fetchAuthors(agentPageId);
  r.ok(
    "P9: the page is stamped with the conversation that created it",
    creators.includes(CONVERSATION),
    JSON.stringify(creators),
  );
  const marked = await fetchAgentOriginPageIds();
  r.ok(
    "P9: the page carries NO agent-origin marker — the 24h sweep never sees it",
    !marked.includes(agentPageId),
    JSON.stringify(marked),
  );

  // Every block in an agent page is the agent's: a page-level line rewritten and
  // a new one added, at the page's own root.
  const pageEdit = await mustWrite("edit_page", {
    block_id: agentPageId,
    old_string: AGENT_PAGE_FIRST,
    new_string: `${AGENT_PAGE_EDITED}\nanother paragraph`,
  });
  r.eq(
    "P9: edit_page on the page rewrites its prose and adds a line — both legal",
    counts(pageEdit),
    { created: 1, deleted: 0, moved: 0, text_edited: 1 },
  );
  r.ok(
    "P9: …attributed to the page",
    (pageEdit.note_ids ?? []).includes(agentPageId),
    JSON.stringify(pageEdit.note_ids ?? null),
  );
  // write_agent_note takes the page's id, and its own read — `# Title` banner
  // included — is a fixed point: the banner is stripped, not written.
  const pageRead = await mustCall("read_page", { block_id: agentPageId });
  const pageRewrite = await mustWrite("write_agent_note", {
    block_id: agentPageId,
    content: pageRead,
  });
  r.eq(
    "P9: write_agent_note of the page's own read writes nothing",
    counts(pageRewrite),
    { created: 0, deleted: 0, moved: 0, text_edited: 0 },
  );

  // An empty agent page a HUMAN inserted: no creator until an agent writes it,
  // and then the first writer is the creator.
  const emptyAgentPage = await seedSubPage(page, pageId, "", "agent").catch(
    (err: unknown): Promise<never> =>
      bail(
        "seed: an empty agent page through turn-into-page with author: agent",
        `${err instanceof Error ? err.message : String(err)} — the rest of P9 is not checkable`,
      ),
  );
  r.ok(
    "P9: an empty agent page a human inserted has no creator yet",
    (await fetchAuthors(emptyAgentPage)).length === 0,
    emptyAgentPage,
  );
  await mustWrite("write_agent_note", {
    block_id: emptyAgentPage,
    content: "filled in by the agent",
  });
  r.ok(
    "P9: …and its first writer becomes its creator",
    (await fetchAuthors(emptyAgentPage)).includes(CONVERSATION),
    emptyAgentPage,
  );

  const afterPageWrites = await fetchBlocks(pageId);
  const agentPointer = `<${AGENT_PAGE_TAG} id="${agentPageId}" title="${AGENT_PAGE_TITLE}"/>`;
  const beforePageRefusals = await snapshot(pageId);
  const beforePageContent = await snapshot(agentPageId);
  const pageRefusals: [
    name: string,
    tool: string,
    args: unknown,
    expect: RegExp,
  ][] = [
    [
      "P9: giving the pointer a BODY (a page's content is written by its own id)",
      "edit_page",
      {
        block_id: pageId,
        old_string: agentPointer,
        new_string:
          `<${AGENT_PAGE_TAG} id="${agentPageId}" title="${AGENT_PAGE_TITLE}">` +
          `\n  smuggled\n</${AGENT_PAGE_TAG}>`,
      },
      /lives in its own page/,
    ],
    [
      "P9: giving the pointer an attribute other than `title`",
      "edit_page",
      {
        block_id: pageId,
        old_string: agentPointer,
        new_string: `<${AGENT_PAGE_TAG} id="${agentPageId}" title="${AGENT_PAGE_TITLE}" icon="x"/>`,
      },
      /takes only `title`/,
    ],
    [
      "P9: a pointer claiming a HUMAN's sub-page is an agent page",
      "edit_page",
      {
        block_id: pageId,
        old_string: `<page id="${humanSubPage}" title="${HUMAN_SUBPAGE_TITLE}"/>`,
        new_string: `<${AGENT_PAGE_TAG} id="${humanSubPage}" title="${HUMAN_SUBPAGE_TITLE}"/>`,
      },
      /cannot be changed through markdown/,
    ],
    [
      // The agent-page rename is P10's, and legal; a HUMAN's page title is the
      // human's, as its prose is.
      "P9: renaming a HUMAN's sub-page through its `# Title` line",
      "edit_page",
      {
        block_id: humanSubPage,
        old_string: `# ${HUMAN_SUBPAGE_TITLE}`,
        new_string: "# Renamed by an agent",
      },
      /TITLE and not a block/,
    ],
    [
      "P9: write_agent_note at a HUMAN's sub-page",
      "write_agent_note",
      { block_id: humanSubPage, content: "hijacked" },
      /its author wrote, not agent-authored/,
    ],
  ];
  for (const [name, tool, args, expect] of pageRefusals) {
    const refused = await callTool(tool, args);
    r.ok(
      `refused: ${name}`,
      !refused.ok && expect.test(refused.text),
      refused.text,
    );
  }
  // The marker is the page's KIND, never changed by a data edit (only the header
  // control's `setPageKind` changes it): a PATCH restating the page's data
  // without it would hand the page back to the human.
  const flipStatus = await patchBlockStatus(page, agentPageId, {
    data: { title: AGENT_PAGE_TITLE, icon: null },
  });
  r.ok(
    "P9: a PATCH dropping the agent marker is a 409",
    flipStatus === 409,
    String(flipStatus),
  );
  r.ok(
    "P9: no refusal wrote anything — the parent and the agent page, five columns each",
    snapshotDiff(beforePageRefusals, await snapshot(pageId)).length === 0 &&
      snapshotDiff(beforePageContent, await snapshot(agentPageId)).length === 0,
    JSON.stringify([
      snapshotDiff(beforePageRefusals, await snapshot(pageId)),
      snapshotDiff(beforePageContent, await snapshot(agentPageId)),
    ]),
  );
  r.ok(
    "P9: the page row still carries its marker after the refused PATCH",
    (
      (await fetchBlocks(pageId)).find((b) => b.id === agentPageId)?.data as
        { author?: string } | undefined
    )?.author === "agent",
    JSON.stringify(afterPageWrites.find((b) => b.id === agentPageId) ?? null),
  );

  // --- P10. an agent renames its page through the `# Title` line -------------
  // The banner stays a line the reader adds on top: the rename is written to the
  // page ROW's data, and the page's content — the only thing the apply writes —
  // must not move at all.
  const RENAMED_TITLE = "Decoder findings, final";
  const beforeRename = await snapshot(agentPageId);
  const renamed = await mustWrite("edit_page", {
    block_id: agentPageId,
    old_string: `# ${AGENT_PAGE_TITLE}`,
    new_string: `# ${RENAMED_TITLE}`,
  });
  r.ok(
    "P10: editing an agent page's `# Title` line reports renamed_to",
    renamed.renamed_to === RENAMED_TITLE,
    JSON.stringify(renamed),
  );
  r.eq("P10: …and writes nothing into the page's content", counts(renamed), {
    created: 0,
    deleted: 0,
    moved: 0,
    text_edited: 0,
  });
  r.ok(
    "P10: …and the content snapshot is byte-identical",
    snapshotDiff(beforeRename, await snapshot(agentPageId)).length === 0,
    JSON.stringify(snapshotDiff(beforeRename, await snapshot(agentPageId))),
  );
  r.ok(
    "P10: the rename is attributed to the page",
    (renamed.note_ids ?? []).includes(agentPageId),
    JSON.stringify(renamed.note_ids ?? null),
  );
  const renamedFacts = await pageRowFacts(pageId, agentPageId);
  r.ok(
    "P10: the page row's stored title changed, and it is still an agent page",
    renamedFacts?.title === RENAMED_TITLE && renamedFacts.author === "agent",
    JSON.stringify(renamedFacts ?? null),
  );
  r.ok(
    "P10: read_page on the page opens with the new title",
    readParts(
      await mustCall("read_page", { block_id: agentPageId }),
    ).body.startsWith(`# ${RENAMED_TITLE}\n\n`),
    RENAMED_TITLE,
  );
  r.ok(
    "P10: the parent's pointer shows the new title",
    (await mustCall("read_page", { block_id: pageId })).includes(
      `<${AGENT_PAGE_TAG} id="${agentPageId}" title="${RENAMED_TITLE}"/>`,
    ),
    RENAMED_TITLE,
  );

  // A title is plain text: a formatted one is refused, and nothing is written —
  // neither the title nor the content.
  const beforeBadRename = await snapshot(agentPageId);
  const formatted = await callTool("edit_page", {
    block_id: agentPageId,
    old_string: `# ${RENAMED_TITLE}`,
    new_string: "# **Bold** findings",
  });
  r.ok(
    "P10: refused: renaming to a FORMATTED title, with the rename hint",
    !formatted.ok &&
      /agent page, so you may rename it/.test(formatted.text) &&
      /plain text/.test(formatted.text),
    formatted.text,
  );
  r.ok(
    "P10: …and the refusal wrote nothing — title and content",
    (await pageRowFacts(pageId, agentPageId))?.title === RENAMED_TITLE &&
      snapshotDiff(beforeBadRename, await snapshot(agentPageId)).length === 0,
    JSON.stringify(await pageRowFacts(pageId, agentPageId)),
  );

  // A rename is an edit of the title line ALONE: renaming and adding a block in
  // one call is refused, and writes neither.
  const beforeMixedRename = await snapshot(agentPageId);
  const mixed = await callTool("edit_page", {
    block_id: agentPageId,
    old_string: `# ${RENAMED_TITLE}\n\n`,
    new_string: "# Another title\n\nA paragraph added in the same edit\n",
  });
  r.ok(
    "P10: refused: a rename that also changes the content, with the rename hint",
    !mixed.ok &&
      /agent page, so you may rename it/.test(mixed.text) &&
      /nothing else/.test(mixed.text),
    mixed.text,
  );
  r.ok(
    "P10: …and the refusal wrote nothing — title and content",
    (await pageRowFacts(pageId, agentPageId))?.title === RENAMED_TITLE &&
      snapshotDiff(beforeMixedRename, await snapshot(agentPageId)).length === 0,
    JSON.stringify(await pageRowFacts(pageId, agentPageId)),
  );

  // Flipped to the human's with the header toggle's endpoint, the page is an
  // ordinary one: the same rename is refused, and so is a write to its body.
  r.ok(
    "P10: the header toggle's endpoint flips the page to the human's",
    (await setPageAuthorStatus(page, agentPageId, "human")) === 200 &&
      (await pageRowFacts(pageId, agentPageId))?.author === undefined,
    JSON.stringify(await pageRowFacts(pageId, agentPageId)),
  );
  const beforeFlippedRefusals = await snapshot(agentPageId);
  const flippedRename = await callTool("edit_page", {
    block_id: agentPageId,
    old_string: `# ${RENAMED_TITLE}`,
    new_string: "# Renamed again",
  });
  r.ok(
    "P10: refused: renaming the page once it is the human's",
    !flippedRename.ok && /TITLE and not a block/.test(flippedRename.text),
    flippedRename.text,
  );
  const flippedBody = await callTool("edit_page", {
    block_id: agentPageId,
    old_string: AGENT_PAGE_EDITED,
    new_string: "rewritten after the flip",
  });
  r.ok(
    "P10: refused: writing the page's body once it is the human's",
    !flippedBody.ok &&
      /outside every agent-authored block/.test(flippedBody.text),
    flippedBody.text,
  );
  r.ok(
    "P10: …and neither refusal wrote anything",
    (await pageRowFacts(pageId, agentPageId))?.title === RENAMED_TITLE &&
      snapshotDiff(beforeFlippedRefusals, await snapshot(agentPageId))
        .length === 0,
    JSON.stringify(
      snapshotDiff(beforeFlippedRefusals, await snapshot(agentPageId)),
    ),
  );

  // Flipped back, the page is the agent's again, all the way down.
  r.ok(
    "P10: the toggle flips the page back to an agent page",
    (await setPageAuthorStatus(page, agentPageId, "agent")) === 200 &&
      (await pageRowFacts(pageId, agentPageId))?.author === "agent",
    JSON.stringify(await pageRowFacts(pageId, agentPageId)),
  );
  const afterFlipBack = await mustWrite("edit_page", {
    block_id: agentPageId,
    old_string: AGENT_PAGE_EDITED,
    new_string: "rewritten after the flip back",
  });
  r.eq("P10: …and a body write is accepted again", counts(afterFlipBack), {
    created: 0,
    deleted: 0,
    moved: 0,
    text_edited: 1,
  });

  // --- P11. instructions are delivered with a read, and gate a write ---------
  // Two fresh conversations per run, so an earlier run's deliveries cannot make
  // a refusal disappear.
  const run = Date.now().toString(36);
  const READER = `e2e-agent-access-reader-${run}`;
  const WRITER = `e2e-agent-access-writer-${run}`;
  const RULE = "a track is a page under Tracks";
  const RULE_ADDED = "a track always names its owner";

  const tracksId = await seedSubPage(page, pageId, "Tracks");
  const rulesId = await seedSubPage(page, tracksId, "Track rules");
  await appendLine(page, rulesId, RULE);
  r.ok(
    "P11: the kind control makes a page an instructions page",
    (await makeInstructionsPage(page, rulesId)) === 200,
  );
  const trackId = await seedSubPage(page, tracksId, "A track", "agent");

  const firstRead = await mustCall("read_page", { block_id: trackId }, READER);
  r.ok(
    "P11: read_page under the instructions opens with them",
    firstRead.startsWith("<received-instructions>") &&
      firstRead.includes(`id="${rulesId}"`) &&
      firstRead.includes(RULE),
    firstRead,
  );
  const secondRead = await mustCall("read_page", { block_id: trackId }, READER);
  r.ok(
    "P11: …and a second read does not repeat them",
    !secondRead.includes("<received-instructions>") &&
      readParts(secondRead).body.startsWith("# A track"),
    secondRead,
  );
  const readerWrite = await callTool(
    "write_agent_note",
    { block_id: trackId, content: "reader note" },
    READER,
  );
  r.ok("P11: the reader may write at once", readerWrite.ok, readerWrite.text);

  const beforeRefusal = await snapshot(trackId);
  const refused = await callTool(
    "write_agent_note",
    { block_id: trackId, content: "writer note" },
    WRITER,
  );
  r.ok(
    "P11: a conversation that never read them is refused, with the rules in the refusal",
    !refused.ok &&
      /nothing was written/.test(refused.text) &&
      refused.text.includes(RULE),
    refused.text,
  );
  r.ok(
    "P11: …and the refusal wrote nothing",
    snapshotDiff(beforeRefusal, await snapshot(trackId)).length === 0,
    JSON.stringify(snapshotDiff(beforeRefusal, await snapshot(trackId))),
  );
  const retried = await callTool(
    "write_agent_note",
    { block_id: trackId, content: "writer note" },
    WRITER,
  );
  r.ok("P11: …and the retry goes through", retried.ok, retried.text);

  await appendLine(page, rulesId, RULE_ADDED);
  const staleWrite = await callTool(
    "edit_page",
    {
      block_id: trackId,
      old_string: "writer note",
      new_string: "writer note, revised",
    },
    WRITER,
  );
  r.ok(
    "P11: edited instructions refuse the writer again, carrying the edit",
    !staleWrite.ok && staleWrite.text.includes(RULE_ADDED),
    staleWrite.text,
  );
  const staleRetry = await callTool(
    "edit_page",
    {
      block_id: trackId,
      old_string: "writer note",
      new_string: "writer note, revised",
    },
    WRITER,
  );
  r.ok("P11: …and its retry goes through", staleRetry.ok, staleRetry.text);
  const staleRead = await mustCall("read_page", { block_id: trackId }, READER);
  r.ok(
    "P11: the reader's next read carries the edited instructions",
    staleRead.startsWith("<received-instructions>") &&
      staleRead.includes(RULE_ADDED),
    staleRead,
  );

  const initInstructions = await initializeInstructions(READER);
  r.ok(
    "P11: an MCP initialize carries the page-instructions section",
    initInstructions.includes("## Page instructions"),
    initInstructions,
  );

  // --- P12. a uniform indentation shift in old_string is forgiven -----------
  // Seed a nested list in the agent page, through the page's own id.
  await mustWrite("edit_page", {
    block_id: agentPageId,
    old_string: "another paragraph",
    new_string:
      "another paragraph\n\n- indent parent\n  - indent child\n\n- twin\n  - twin",
  });
  const indentRead = await mustCall("read_page", { block_id: agentPageId });
  const readLines = indentRead.split("\n");
  const childLine = readLines.find((l) =>
    l.trimStart().endsWith("indent child"),
  );
  const parentLine = readLines.find((l) =>
    l.trimStart().endsWith("indent parent"),
  );
  const seeded = await fetchBlocks(agentPageId);
  const childRow = seeded.find((b) => rowText(b) === "indent child");
  const parentRow = seeded.find((b) => rowText(b) === "indent parent");
  if (
    childLine === undefined ||
    parentLine === undefined ||
    !childRow ||
    !parentRow
  ) {
    return await bail("P12: seed: a nested list in the agent page", indentRead);
  }
  const leadOf = (line: string) => line.length - line.trimStart().length;
  const unit = " ".repeat(leadOf(childLine) - leadOf(parentLine));
  r.ok(
    "P12: seed: the child line is indented in the page's read",
    unit.length > 0,
    JSON.stringify({ parentLine, childLine }),
  );
  const marker = childLine.trimStart().slice(0, 1);

  // Page read → edit through the parent's id. A block's read holds only what is
  // nested UNDER it, so the child line sits at depth zero there — the shape of
  // the original failure, a line copied from the page and edited through the
  // `<todo>` card around it.
  const deeper = await mustWrite("edit_page", {
    block_id: parentRow.id,
    old_string: childLine,
    new_string: `${childLine}\n${" ".repeat(leadOf(childLine))}${unit}${marker} indent grandchild`,
  });
  r.eq(
    "P12: a line copied from the page's read matches through its parent's id, reindented",
    deeper.reindented,
    { from: leadOf(childLine), to: 0 },
  );
  const grandchild = (await fetchBlocks(agentPageId)).find(
    (b) => rowText(b) === "indent grandchild",
  );
  r.ok(
    "P12: …and the new line lands as the child's child",
    grandchild?.parentId === childRow.id,
    JSON.stringify(grandchild ?? null),
  );

  // The reverse: the parent's read → edit through the page.
  const parentRead = await mustCall("read_page", { block_id: parentRow.id });
  const snippet = parentRead.trimEnd();
  const shallower = await mustWrite("edit_page", {
    block_id: agentPageId,
    old_string: snippet,
    new_string: snippet.replace(
      "indent grandchild",
      "indent grandchild, revised",
    ),
  });
  r.eq(
    "P12: text from a block's read matches through the page, reindented",
    [shallower.reindented, counts(shallower)],
    [
      { from: 0, to: leadOf(childLine) },
      { created: 0, deleted: 0, moved: 0, text_edited: 1 },
    ],
  );

  // The same line at two depths: refused, and nothing written.
  const twinLine = readLines.find((l) => l.trimStart().endsWith("twin"));
  const beforeTwin = await snapshot(agentPageId);
  const twin = await callTool("edit_page", {
    block_id: agentPageId,
    old_string: `${unit}${unit}${twinLine?.trimStart() ?? "- twin"}`,
    new_string: `${unit}${unit}${marker} renamed twin`,
  });
  r.ok(
    "P12: refused: text matching at two depths, naming both",
    !twin.ok &&
      /matches 2 times/.test(twin.text) &&
      /indentation/.test(twin.text),
    twin.text,
  );
  r.ok(
    "P12: …and the refusal wrote nothing",
    snapshotDiff(beforeTwin, await snapshot(agentPageId)).length === 0,
    JSON.stringify(snapshotDiff(beforeTwin, await snapshot(agentPageId))),
  );

  // --- P-tags. a page's tags are written through the <page-meta> header ------
  {
    const uniq = `E2E tag ${Date.now().toString(36)}`;
    const vocab = async (): Promise<
      { id: string; name: string; color: string }[]
    > => {
      const res = await agentFetch("/api/resources/page-tags.vocabulary");
      if (!res.ok) throw new Error(`page-tags.vocabulary: HTTP ${res.status}`);
      return (
        (await res.json()) as {
          value: { id: string; name: string; color: string }[];
        }
      ).value;
    };
    if (!(await vocab()).some((t) => t.name === "In progress")) {
      const made = await agentFetch("/api/page-tags", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: "In progress", color: "blue" }),
      });
      if (!made.ok)
        return await bail("P-tags: seed vocabulary", await made.text());
    }
    const tagPage = agentPageId;
    const tagRead = () => mustCall("read_page", { block_id: tagPage });

    const read0 = await tagRead();
    r.ok(
      "P-tags: an untagged page reads <tags/>",
      read0.includes("<tags/>"),
      read0.slice(0, 400),
    );
    const tagsLine = read0.split("\n").find((l) => l.includes("<tags/>")) ?? "";
    const indent = tagsLine.slice(
      0,
      tagsLine.length - tagsLine.trimStart().length,
    );

    const set = (await mustWrite("edit_page", {
      block_id: tagPage,
      old_string: "<tags/>",
      new_string: `<tags>\n${indent}  <tag name="in PROGRESS"/>\n${indent}</tags>`,
    })) as ApplySummary & { tags_set?: string[]; tags_created?: string[] };
    r.eq(
      "P-tags: a tag name resolves case-insensitively to its canonical spelling",
      set.tags_set,
      ["In progress"],
    );
    r.ok(
      "P-tags: …and the re-read shows it",
      (await tagRead()).includes('<tag name="In progress"/>'),
    );
    r.ok(
      "P-tags: a tag-only edit reports no page_meta_ignored",
      set.page_meta_ignored === undefined,
      JSON.stringify(set),
    );

    const typo = await callTool("edit_page", {
      block_id: tagPage,
      old_string: '<tag name="In progress"/>',
      new_string: '<tag name="Inprogres"/>',
    });
    r.ok(
      "P-tags: an unknown name is refused, suggesting the closest tag",
      !typo.ok &&
        /400/.test(typo.text + "400") &&
        typo.text.includes("In progress"),
      typo.text,
    );
    r.ok(
      "P-tags: …and nothing changed",
      (await tagRead()).includes('<tag name="In progress"/>'),
    );

    const made = (await mustWrite("edit_page", {
      block_id: tagPage,
      old_string: '<tag name="In progress"/>',
      new_string: `<tag name="In progress"/>\n${indent}  <tag name="${uniq}" new="true" color="red"/>`,
    })) as ApplySummary & { tags_set?: string[]; tags_created?: string[] };
    const created = (await vocab()).find((t) => t.name === uniq);
    r.ok(
      "P-tags: new=true creates the tag, with its colour",
      made.tags_created?.includes(uniq) === true && created?.color === "red",
      JSON.stringify({ made, created }),
    );

    // Tag edit + content edit in ONE call: one old/new pair spanning the header's
    // tag list through a body line.
    const contentLine = "indent grandchild, revised";
    const read2 = await tagRead();
    const from = read2.indexOf("<tags>");
    const to = read2.indexOf(contentLine) + contentLine.length;
    const span = read2.slice(from, to);
    const both2 = (await mustWrite("edit_page", {
      block_id: tagPage,
      old_string: span,
      new_string: span
        .replace(new RegExp(`\\s*<tag name="${uniq}"[^>]*/>`), "")
        .replace(contentLine, `${contentLine} and tagged`),
    })) as ApplySummary & { tags_set?: string[] };
    r.ok(
      "P-tags: a tag edit and a content edit in one call write both",
      JSON.stringify(both2.tags_set) === JSON.stringify(["In progress"]) &&
        both2.text_edited === 1 &&
        (await fetchBlocks(tagPage)).some(
          (b) => rowText(b) === `${contentLine} and tagged`,
        ),
      JSON.stringify(both2),
    );

    const crumb = readParts(await tagRead()).breadcrumb.at(-1);
    const crumbEdit = await mustWrite("edit_page", {
      block_id: tagPage,
      old_string: `title="${crumb?.title}"`,
      new_string: 'title="Renamed crumb"',
    });
    r.ok(
      "P-tags: editing a breadcrumb title reports page_meta_ignored",
      crumbEdit.page_meta_ignored !== undefined,
      JSON.stringify({ crumb, crumbEdit }),
    );

    if (created) {
      const del = await agentFetch(`/api/page-tags/${created.id}`, {
        method: "DELETE",
      });
      r.ok("P-tags: cleanup deletes the e2e tag", del.ok, String(del.status));
    }
  }

  await snap(page, out, "after-notes");
  await r.finish();
});
