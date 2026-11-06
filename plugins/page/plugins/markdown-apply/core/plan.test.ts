import { describe, expect, test } from "bun:test";
import { z } from "zod";
import {
  PageDataSchema,
  defineBlock,
  isEmptyPatch,
  pageBlockAuthor,
  pageBlockMarkdown,
  namesField,
  parseMarkdownToForest,
  plainOf,
  runsOf,
  serializeForestToMarkdown,
  textBlockSchema,
  textDataSchema,
  type BlockHandle,
  type BlockPatch,
  type MarkdownContext,
  type RichText,
} from "@plugins/page/plugins/editor/core";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { documentOrderRows, markdownNodesOfRows } from "./flatten";
import { dropInertNodes, dropInertRows, type InertBlocks } from "./inert";
import { planMarkdownApply, type MarkdownApplyPlan } from "./plan";
import type { StoredRow } from "./stored-row";

// Handles are built LOCALLY with the real `defineBlock`, mirroring the block
// plugins' declarations — the same choice `markdown.test.ts` makes and for the
// same reason: every block plugin imports the editor's `defineBlock`, so
// importing them back here would form a plugin import cycle the boundary checker
// (which scans test files) would reject.

const text = defineBlock({
  type: "text",
  schema: textDataSchema,
  defaultText: true,
  empty: () => ({ text: [] }),
  // Mirrors `page/text`: an empty paragraph is a blank line, and the tag stays
  // parse-only so `<text/>` written before that dialect still comes back.
  markdown: {
    serialize: (d, ctx) => (plainOf(d.text).length === 0 ? "" : ctx.md(d.text)),
    tag: {
      name: "text",
      body: "none",
      // Mirrors `page/text`: no attributes, so the pin emits a bare `<text/>`
      // rather than the derived `<text data="{&quot;text&quot;:[]}"/>`.
      attrs: () => ({}),
      parseAttrs: () => ({ text: [] }),
    },
  },
});

const bulletedList = defineBlock({
  type: "bulleted-list",
  schema: textDataSchema,
  empty: () => ({ text: [] }),
  marker: "•",
  markdownPrefixes: ["* ", "- ", "+ "],
});

const heading1 = defineBlock({
  type: "heading-1",
  schema: textDataSchema,
  empty: () => ({ text: [] }),
  markdownPrefixes: ["# "],
});

const toDo = defineBlock({
  type: "to-do",
  schema: textBlockSchema({ checked: z.boolean().default(false) }),
  empty: () => ({ text: [], checked: false }),
  markdown: {
    precedence: 10,
    serialize: (d, ctx) => `- [${d.checked ? "x" : " "}] ` + ctx.md(d.text),
    parseLine: {
      claims: ["- [ ] x", "[ ] x", "* [X] x", "+ [x] x"],
      parse: (line, ctx) => {
        const m = /^[-*+]?\s*\[([ xX])\]\s+(.*)$/.exec(line);
        if (!m) return null;
        return { text: ctx.runs(m[2]!), checked: m[1]!.toLowerCase() === "x" };
      },
    },
  },
  markdownPrefixes: ["[] ", "[ ] "],
});

const toggle = defineBlock({
  type: "toggle",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
  markdownPrefixes: ["> "],
  collapsible: "always",
});

const quote = defineBlock({
  type: "quote",
  schema: textDataSchema,
  empty: () => ({ text: [] }),
  markdown: { tag: { body: "text" } },
});

const callout = defineBlock({
  type: "callout",
  schema: z.object({
    icon: z.string().nullable().default(null),
    color: z.enum(["default", "info"]).default("default"),
  }),
  empty: () => ({ icon: null, color: "default" as const }),
  anchor: true,
});

// The three IDENTIFIED containers: void cards that round-trip their ROW ID as
// the reserved `id` attribute, which is what makes them addressable — an agent
// reading the document gets an anchor it can hand straight back. Mirrors the
// real `agent-notes` / `private-notes` / `todo` declarations (a container is
// `anchor: true`, void, with a `children` body); three rather than one so a
// document holding several identified TYPES is covered, not just several cards.
const identifiedContainer = (type: string): BlockHandle<unknown> =>
  defineBlock({
    type,
    schema: z.object({}),
    empty: () => ({}),
    anchor: true,
    markdown: { tag: { body: "children", identified: true } },
  }) as BlockHandle<unknown>;

const agentNotes = identifiedContainer("agent-notes");
const privateNotes = identifiedContainer("private-notes");
const todo = identifiedContainer("todo");

const image = defineBlock({
  type: "image",
  schema: z.object({
    attachmentId: z.string().optional(),
    width: z.number().int().positive().optional(),
  }),
  empty: () => ({}),
});

const divider = defineBlock({
  type: "divider",
  schema: z.object({}),
  empty: () => ({}),
  markdown: {
    serialize: () => "---",
    parseLine: {
      claims: ["---"],
      parse: (line) => (line.trim() === "---" ? {} : null),
    },
  },
  markdownPrefixes: ["---"],
});

const codeBlock = defineBlock({
  type: "code-block",
  schema: z.object({
    code: z.string().default(""),
    language: z.string().optional(),
    view: z.enum(["code", "preview", "split"]).optional(),
  }),
  // Mirrors `page/code-block`: the split view is how it is SHOWN.
  displayOnly: ["view"],
  empty: () => ({ code: "" }),
  markdown: {
    fence: {
      open: "```",
      close: "```",
      parseFenced: (info, body) => ({
        code: body,
        ...(info ? { language: info } : {}),
      }),
    },
    serialize: (d) => "```" + (d.language ?? "") + "\n" + d.code + "\n```",
  },
  markdownPrefixes: ["```"],
});

// The two `<page …>` halves: the sub-page SERIALIZES the tag (identity from
// `ctx.id`), `page-link` OWNS it on parse. The page handle is the REAL shared
// declaration (editor core, which this plugin already imports): its second
// spelling, `<agent-page>`, is what the agent-authored-page cases below pin, and
// a local copy would pin the copy.
const page = defineBlock({
  type: "page",
  schema: PageDataSchema,
  markdown: pageBlockMarkdown,
  ...pageBlockAuthor,
});

const pageLink = defineBlock({
  type: "page-link",
  schema: z.object({ pageId: z.string() }),
  empty: () => ({ pageId: "" }),
  markdown: {
    tag: {
      name: "page",
      body: "none",
      annotated: ["title"],
      attrs: (data) => ({ id: data.pageId }),
      parseAttrs: (attrs) => {
        const id = attrs.id;
        if (id === undefined || id === "")
          throw new Error("<page/> needs an `id`");
        return { pageId: id };
      },
    },
  },
});

const handles: BlockHandle<unknown>[] = [
  text,
  bulletedList,
  heading1,
  toDo,
  toggle,
  quote,
  callout,
  agentNotes,
  privateNotes,
  todo,
  image,
  divider,
  codeBlock,
  page,
  pageLink,
] as BlockHandle<unknown>[];

const byType = new Map(handles.map((h) => [h.type, h] as const));
const ctx: MarkdownContext = {
  handles,
  protectedSpans: [],
  // The server dialect: this module's documents are ones this codebase emitted.
  blankLines: "empty-block",
  // The server dialect on the way out too: an empty paragraph whose position a
  // blank line cannot state is pinned as `<text/>`, and a soft break is spelled
  // `\n` so the block stays one line — together, a faithful read applied
  // straight back plans nothing.
  emptyBlocks: "pinned",
  softBreaks: "escaped",
};

const PAGE_ID = "PAGE";

// ---------------------------------------------------------------------------
// Row fixtures
// ---------------------------------------------------------------------------

interface RawNode {
  type: string;
  data: unknown;
  children: RawNode[];
}

const raw = (
  type: string,
  data: unknown,
  children: RawNode[] = [],
): RawNode => ({
  type,
  data,
  children,
});
const runs = (s: string): RichText => (s ? [{ text: s }] : []);

/** Ids in DFS order (`b1`, `b2`, …); ranks minted per sibling list. */
function rowsOf(forest: RawNode[], pageId = PAGE_ID): StoredRow[] {
  const rows: StoredRow[] = [];
  let n = 0;
  const walk = (nodes: RawNode[], parentId: string): void => {
    const ranks = Rank.nBetween(null, null, nodes.length);
    nodes.forEach((node, i) => {
      const id = `b${++n}`;
      rows.push({
        id,
        parentId,
        type: node.type,
        data: node.data,
        rank: ranks[i]!.toJSON(),
        expanded: true,
      });
      walk(node.children, id);
    });
  };
  walk(forest, pageId);
  return rows;
}

/**
 * The document a ROOT projects. `rootId` defaults to the page, so every
 * page-scoped test below reads exactly as it did before roots existed; a
 * subtree-rooted test passes a block id and gets that block's CONTENT.
 */
const markdownOf = (rows: StoredRow[], rootId = PAGE_ID): string =>
  serializeForestToMarkdown(markdownNodesOfRows(rows, rootId), ctx);

/** A row filter, as a redacting caller passes one in. */
type Redact = (rows: StoredRow[]) => StoredRow[];

/** `pageId` stays `PAGE_ID` throughout: these fixtures are all one page. */
const planResult = (
  rows: StoredRow[],
  md: string,
  rootId = PAGE_ID,
  redact?: Redact,
) =>
  planMarkdownApply({
    rootId,
    pageId: PAGE_ID,
    existing: rows,
    incoming: parseMarkdownToForest(md, ctx),
    handles,
    redact,
  });

function planOf(
  rows: StoredRow[],
  md: string,
  rootId = PAGE_ID,
  redact?: Redact,
): MarkdownApplyPlan {
  const result = planResult(rows, md, rootId, redact);
  if (!result.ok)
    throw new Error(`refused: ${result.reason} — ${result.detail}`);
  return result.plan;
}

/** Round-trip a page through markdown and plan the result back onto it. */
const replan = (rows: StoredRow[]): MarkdownApplyPlan =>
  planOf(rows, markdownOf(rows));

const namedFields = (patch: BlockPatch): Set<string> => {
  const named = new Set<string>();
  for (const u of patch.updates)
    for (const k of Object.keys(u.changes)) named.add(k);
  return named;
};

const plainTextOfRow = (row: StoredRow): string =>
  plainOf((row.data as { text?: unknown }).text);

/**
 * The write path, modelled: apply the patch's row changes AND the text channel's
 * runs (which the real applier splices into each block's content doc and then
 * projects back onto `data.text`). Everything downstream of the plan reads the
 * result of BOTH channels, so a test that applied only the patch would be
 * checking half the answer.
 */
function applyPlan(rows: StoredRow[], plan: MarkdownApplyPlan): StoredRow[] {
  const gone = new Set(plan.patch.deleteIds);
  const out = rows
    .filter((row) => !gone.has(row.id))
    .map((row) => ({ ...row }));
  const byId = new Map(out.map((row) => [row.id, row] as const));
  for (const update of plan.patch.updates) {
    const row = byId.get(update.id);
    if (!row) continue; // an update never creates
    if (namesField(update.changes, "parentId"))
      row.parentId = update.changes.parentId!;
    if (namesField(update.changes, "type")) row.type = update.changes.type!;
    if (namesField(update.changes, "rank"))
      row.rank = String(update.changes.rank);
    if (namesField(update.changes, "expanded"))
      row.expanded = update.changes.expanded!;
    if (namesField(update.changes, "data")) row.data = update.changes.data;
  }
  for (const created of plan.patch.creates) {
    out.push({
      id: created.id,
      parentId: created.parentId,
      type: created.type,
      data: created.data,
      rank: String(created.rank),
      expanded: created.expanded,
    });
  }
  for (const edit of plan.textEdits) {
    const row = out.find((r) => r.id === edit.blockId);
    if (!row) continue;
    row.data = { ...(row.data as object), text: edit.runs };
  }
  return out;
}

/**
 * THE end-to-end property of the engine: whatever the plan is, applying it must
 * reproduce the document that was asked for. Every field-level assertion below
 * is about MINIMALITY; this one is about correctness, and it is what makes the
 * minimality assertions safe to relax where two answers are equally minimal.
 */
function expectConverges(
  rows: StoredRow[],
  target: StoredRow[],
  label: unknown,
  rootId = PAGE_ID,
): void {
  const md = markdownOf(target, rootId);
  const plan = planOf(rows, md, rootId);
  expect({ label, md: markdownOf(applyPlan(rows, plan), rootId) }).toEqual({
    label,
    md,
  });
}

// ---------------------------------------------------------------------------
// THE property: identity ⇒ no writes
// ---------------------------------------------------------------------------

describe("identity ⇒ no writes", () => {
  test("a page re-applied from its own markdown emits nothing", () => {
    const rows = rowsOf([
      raw("heading-1", { text: runs("Title") }),
      raw("text", { text: runs("A paragraph.") }, [
        raw("bulleted-list", { text: runs("nested") }),
      ]),
      raw("to-do", { text: runs("ship it"), checked: true }),
      raw("code-block", { code: "const x = 1;", language: "ts" }),
      raw("divider", {}),
      raw("image", { attachmentId: "att_1", width: 640 }),
      raw("page", { title: "Sub", icon: null }),
    ]);
    const plan = replan(rows);
    expect(isEmptyPatch(plan.patch)).toBe(true);
    expect(plan.textEdits).toEqual([]);
    expect(plan.stats).toEqual({
      survived: rows.length,
      created: 0,
      deleted: 0,
      moved: 0,
    });
  });

  test("display-only data is never written by a re-apply", () => {
    // Markdown cannot say `view`, so the parse comes back without it — and a
    // survivor that then wrote the parse would reset how the block is shown on
    // every apply, however unrelated the edit.
    const rows = rowsOf([
      raw("code-block", {
        code: "graph TD",
        language: "mermaid",
        view: "code",
      }),
      raw("text", { text: runs("after") }),
    ]);
    expect(isEmptyPatch(replan(rows).patch)).toBe(true);
  });

  test("an edit to a block keeps its display-only data", () => {
    const rows = rowsOf([
      raw("code-block", {
        code: "graph TD",
        language: "mermaid",
        view: "code",
      }),
    ]);
    const md = markdownOf(rows).replace("graph TD", "graph LR");
    const plan = planOf(rows, md);
    expect(plan.patch.creates).toEqual([]);
    expect(plan.patch.deleteIds).toEqual([]);
    expect(plan.patch.updates.map((u) => u.changes.data)).toEqual([
      { code: "graph LR", language: "mermaid", view: "code" },
    ]);
  });

  test("a COLLAPSED block stays collapsed — `expanded` is never written", () => {
    // A parsed forest is uniformly `expanded: true`, so the only thing standing
    // between an apply and every collapse state on the page is this invariant.
    const rows = rowsOf([
      raw("toggle", { text: runs("folded") }, [
        raw("text", { text: runs("hidden") }),
      ]),
    ]);
    rows[0]!.expanded = false;
    const plan = replan(rows);
    expect(isEmptyPatch(plan.patch)).toBe(true);
  });

  test("marks-only differences ride the TEXT channel, never the row", () => {
    const rows = rowsOf([raw("text", { text: runs("hello") })]);
    const md = "**hello**";
    const plan = planOf(rows, md);
    expect(isEmptyPatch(plan.patch)).toBe(true);
    expect(plan.textEdits).toEqual([
      { blockId: "b1", runs: [{ text: "hello", marks: ["bold"] }] },
    ]);
  });
});

// ---------------------------------------------------------------------------
// The case that motivates an LCS over a content bucket
// ---------------------------------------------------------------------------

describe("repeated identical lines", () => {
  const fiveItems = (): StoredRow[] =>
    rowsOf([
      raw("bulleted-list", { text: runs("item") }),
      raw("bulleted-list", { text: runs("item") }),
      raw("bulleted-list", { text: runs("item") }),
      raw("bulleted-list", { text: runs("item") }),
      raw("bulleted-list", { text: runs("item") }),
    ]);

  test("editing one of five identical bullets keeps ALL FIVE ids", () => {
    // The case that motivates an LCS over the pages-history content bucket: five
    // identical keys. A bucket matcher pops them in arbitrary order, so editing
    // one re-pairs the lot. Which of the five ends up carrying the edited text is
    // genuinely unanswerable — the rows are indistinguishable — so the assertion
    // is on the id SET, plus the single text edit and the absence of churn.
    const rows = fiveItems();
    const md = ["* item", "* item", "* item edited", "* item", "* item"].join(
      "\n",
    );
    const plan = planOf(rows, md);
    expect(plan.patch.creates).toEqual([]);
    expect(plan.patch.deleteIds).toEqual([]);
    expect(plan.textEdits).toHaveLength(1);
    expect(plan.textEdits[0]!.runs).toEqual([{ text: "item edited" }]);
    expect(markdownOf(applyPlan(rows, plan))).toBe(md);
  });

  test("deleting the FOURTH of five identical bullets deletes exactly one row", () => {
    const rows = fiveItems();
    const md = ["* item", "* item", "* item", "* item"].join("\n");
    const plan = planOf(rows, md);
    // Any of the five would be a "correct" delete by content alone; only a
    // positional alignment can say which, and the ranks prove it picked one
    // WITHOUT re-ranking the survivors.
    expect(plan.patch.deleteIds).toHaveLength(1);
    expect(plan.patch.creates).toEqual([]);
    expect(plan.patch.updates).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Sub-pages
// ---------------------------------------------------------------------------

describe("sub-pages", () => {
  const withShell = (): StoredRow[] =>
    rowsOf([
      raw("text", { text: runs("before") }),
      raw("page", { title: "Sub", icon: null }),
      raw("text", { text: runs("after") }),
    ]);

  test("a shell OMITTED from the markdown is preserved, never deleted", () => {
    const rows = withShell();
    const md = ["before", "after"].join("\n");
    const plan = planOf(rows, md);
    expect(plan.patch.deleteIds).toEqual([]);
    expect(plan.patch.creates).toEqual([]);
    // Kept at the top level, after everything the document did place.
    const shellUpdate = plan.patch.updates.find((u) => u.id === "b2");
    expect(shellUpdate).toBeDefined();
    expect(namesField(shellUpdate!.changes, "rank")).toBe(true);
    const shellRank = String(shellUpdate!.changes.rank);
    const others = ["b1", "b3"].map(
      (id) => rows.find((r) => r.id === id)!.rank,
    );
    for (const rank of others) {
      expect(Rank.compare(Rank.from(shellRank), Rank.from(rank))).toBe(1);
    }
  });

  test("a shell MOVED in the markdown is repositioned, keeping its id", () => {
    const rows = withShell();
    const md = ["before", "after", `<page id="b2"/>`].join("\n");
    const plan = planOf(rows, md);
    expect(plan.patch.deleteIds).toEqual([]);
    expect(plan.patch.creates).toEqual([]);
    // ONE re-rank realizes the reorder. Which of the two blocks that swapped
    // places is the one that "moved" is not determined — two subsequences of the
    // stored ranks are equally long — so the assertion is that the cost is one
    // rank, and that the document really ends up in the asked-for order.
    expect(plan.patch.updates).toHaveLength(1);
    expect(Object.keys(plan.patch.updates[0]!.changes)).toEqual(["rank"]);
    expect(markdownOf(applyPlan(rows, plan))).toBe(md);
  });

  test("a shell never takes the pointer type's `type` or `data`", () => {
    const rows = withShell();
    const plan = replan(rows);
    expect(isEmptyPatch(plan.patch)).toBe(true);
  });

  test("an INVENTED page reference is refused, loudly", () => {
    const rows = withShell();
    const md = [
      "before",
      `<page id="ghost"/>`,
      "after",
      `<page id="b2"/>`,
    ].join("\n");
    const result = planResult(rows, md);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unknown-ref");
  });

  test("a page-link the document ALREADY holds round-trips (it vouches for itself)", () => {
    // The same `<page id="…"/>` syntax serializes an ordinary link-to-page block
    // pointing anywhere. Refusing every id that is not a sub-page of THIS page
    // would break every such block on every apply.
    const rows = rowsOf([
      raw("text", { text: runs("see") }),
      raw("page-link", { pageId: "elsewhere" }),
    ]);
    const plan = replan(rows);
    expect(isEmptyPatch(plan.patch)).toBe(true);
  });

  test("referencing one shell TWICE is refused rather than duplicated", () => {
    const rows = withShell();
    const md = ["before", `<page id="b2"/>`, "after", `<page id="b2"/>`].join(
      "\n",
    );
    const result = planResult(rows, md);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("ref-duplicated");
  });

  test("a shell whose PARENT is deleted survives at the top level", () => {
    const rows = rowsOf([
      raw("text", { text: runs("parent") }, [
        raw("page", { title: "Sub", icon: null }),
      ]),
    ]);
    // The whole document is emptied — so the shell's parent really is deleted,
    // and the shell has to be lifted out BEFORE the delete cascade reaches it
    // (which is exactly the order `applyPageBlockPatch` writes in).
    const plan = planOf(rows, "");
    expect(plan.patch.deleteIds).toEqual(["b1"]);
    const shellUpdate = plan.patch.updates.find((u) => u.id === "b2")!;
    expect(shellUpdate.changes.parentId).toBe(PAGE_ID);
  });
});

// ---------------------------------------------------------------------------
// Agent-authored pages: a pointer PINS, a tagless tag MINTS
// ---------------------------------------------------------------------------
//
// `<agent-page id="…" title="…"/>` is the identified spelling of a `page` row,
// so it rides the card's `ref` machinery with three extra conditions (same
// kind, canonical spelling, no body); `<agent-page title="…">body</agent-page>`
// with no id is a page this apply CREATES, whose body joins the new partition
// and is asserted new so no stored row can be paired into it.

describe("agent-authored pages", () => {
  const agentPage = (title: string) => ({
    title,
    icon: null,
    author: "agent" as const,
  });
  // b1 "intro" | b2 <agent-page "Findings"> | b3 <page "Human"> | b4 card > b5
  const withPages = (): StoredRow[] =>
    rowsOf([
      raw("text", { text: runs("intro") }),
      raw("page", agentPage("Findings")),
      raw("page", { title: "Human", icon: null }),
      raw("agent-notes", {}, [raw("text", { text: runs("noted") })]),
    ]);
  const MINT = [
    `<agent-page title="New">`,
    "  first",
    `  <agent-page title="Inner">`,
    "    deep",
    "  </agent-page>",
    "</agent-page>",
  ].join("\n");
  const refusal = (rows: StoredRow[], md: string) => {
    const result = planResult(rows, md);
    if (result.ok) throw new Error("expected a refusal");
    return result;
  };

  test("the read's pointer carries the id and title, and re-applies to nothing", () => {
    const rows = withPages();
    expect(markdownOf(rows)).toContain(
      `<agent-page id="b2" title="Findings"/>`,
    );
    const plan = replan(rows);
    expect(isEmptyPatch(plan.patch)).toBe(true);
  });

  test("a pinned agent page is REPOSITION-only when it moves", () => {
    const rows = withPages();
    const md = markdownOf(rows).replace(
      `intro\n<agent-page id="b2" title="Findings"/>`,
      `<agent-page id="b2" title="Findings"/>\nintro`,
    );
    const plan = planOf(rows, md);
    expect(plan.patch.creates).toEqual([]);
    expect(plan.patch.deleteIds).toEqual([]);
    for (const update of plan.patch.updates) {
      expect(Object.keys(update.changes)).toEqual(["rank"]);
    }
    expect(markdownOf(applyPlan(rows, plan))).toBe(md);
  });

  test("a changed — or stale — title on a pointer is IGNORED, never written", () => {
    const rows = withPages();
    const md = markdownOf(rows).replace(`title="Findings"`, `title="Renamed"`);
    expect(isEmptyPatch(planOf(rows, md).patch)).toBe(true);
  });

  test("a pointer given a BODY is refused, naming where the content lives", () => {
    const rows = withPages();
    const md = markdownOf(rows).replace(
      `<agent-page id="b2" title="Findings"/>`,
      `<agent-page id="b2" title="Findings">\n  smuggled\n</agent-page>`,
    );
    const result = refusal(rows, md);
    expect(result.reason).toBe("ref-out-of-scope");
    expect(result.detail).toMatch(/pass b2 as the block id/);
  });

  test("a pointer given an attribute other than `title` fails at the parse", () => {
    const rows = withPages();
    const md = markdownOf(rows).replace(
      `title="Findings"`,
      `title="Findings" icon="x"`,
    );
    expect(() => planResult(rows, md)).toThrow(/takes only `title`/);
  });

  test("`<agent-page id>` naming a HUMAN's page is unknown-ref — the spelling is canonical", () => {
    const rows = withPages();
    const md = markdownOf(rows).replace(
      `<page id="b3"/>`,
      `<agent-page id="b3" title="Human"/>`,
    );
    expect(refusal(rows, md).reason).toBe("unknown-ref");
  });

  test("turning an agent page into a link is refused", () => {
    const rows = withPages();
    const md = markdownOf(rows).replace(
      `<agent-page id="b2" title="Findings"/>`,
      `<page id="b2"/>`,
    );
    expect(refusal(rows, md).reason).toBe("unknown-ref");
  });

  test("a card ref at a page row, and a pointer at a card, are refused", () => {
    const rows = withPages();
    const cardAtPage = markdownOf(rows).replace(
      `<agent-page id="b2" title="Findings"/>`,
      `<agent-notes id="b2"/>`,
    );
    expect(refusal(rows, cardAtPage).reason).toBe("unknown-ref");
    const pageAtCard = markdownOf(rows).replace(
      [`<agent-notes id="b4">`, "  noted", "</agent-notes>"].join("\n"),
      `<agent-page id="b4" title="x"/>`,
    );
    expect(refusal(rows, pageAtCard).reason).toBe("unknown-ref");
  });

  test("a mint creates the page and its body, each create in its right partition", () => {
    const rows = withPages();
    const plan = planOf(rows, `${markdownOf(rows)}\n${MINT}`);
    expect(plan.patch.updates).toEqual([]);
    expect(plan.patch.deleteIds).toEqual([]);
    const [outer, first, inner, deep] = plan.patch.creates;
    expect(plan.patch.creates).toHaveLength(4);
    // The new page row is displayed in THIS page, so it joins this partition…
    expect(outer).toMatchObject({
      type: "page",
      pageId: PAGE_ID,
      parentId: PAGE_ID,
      data: agentPage("New"),
    });
    // …and everything under it joins the NEW page's, nesting included.
    expect(first).toMatchObject({ pageId: outer!.id, parentId: outer!.id });
    expect(inner).toMatchObject({
      type: "page",
      pageId: outer!.id,
      parentId: outer!.id,
      data: agentPage("Inner"),
    });
    expect(deep).toMatchObject({ pageId: inner!.id, parentId: inner!.id });
  });

  test("a minted page is born FOLDED, as turn-into-page folds one", () => {
    const rows = withPages();
    const plan = planOf(rows, `${markdownOf(rows)}\n${MINT}`);
    const pages = plan.patch.creates.filter((b) => b.type === "page");
    expect(pages.map((p) => p.expanded)).toEqual([false, false]);
    expect(
      plan.patch.creates
        .filter((b) => b.type !== "page")
        .map((b) => b.expanded),
    ).toEqual([true, true]);
  });

  test("a line MOVED from this page into a new body is a create there, never a paired move", () => {
    // Hazard: pass 3 pairs by content across the whole document, so without the
    // asserted-new pin `intro` would keep its row and land in the new page with
    // this page's `page_id` — a row visible in neither.
    const rows = withPages();
    const md = markdownOf(rows)
      .replace("intro\n", "")
      .concat(`\n<agent-page title="New">\n  intro\n</agent-page>`);
    const plan = planOf(rows, md);
    expect(plan.patch.deleteIds).toEqual(["b1"]);
    expect(plan.patch.updates.some((u) => u.id === "b1")).toBe(false);
    const page = plan.patch.creates.find((b) => b.type === "page")!;
    const moved = plan.patch.creates.find((b) => b.type === "text")!;
    expect(moved).toMatchObject({ pageId: page.id, parentId: page.id });
  });

  test("an identical paragraph inside a new body is still a CREATE", () => {
    const rows = withPages();
    const md = `${markdownOf(rows)}\n<agent-page title="New">\n  intro\n</agent-page>`;
    const plan = planOf(rows, md);
    expect(plan.patch.updates).toEqual([]);
    expect(plan.patch.creates.map((b) => b.type)).toEqual(["page", "text"]);
  });

  test("ranks are fresh: the body is its own sibling list, nothing on the page re-ranks", () => {
    const rows = withPages();
    const plan = planOf(rows, `${markdownOf(rows)}\n${MINT}`);
    expect(plan.patch.updates).toEqual([]);
    const outer = plan.patch.creates[0]!;
    const last = rows.find((r) => r.id === "b4")!;
    expect(Rank.compare(outer.rank, Rank.from(last.rank))).toBe(1);
  });

  test("an identity claim INSIDE a new page is ref-out-of-scope — a row cannot move between pages", () => {
    const rows = withPages();
    for (const claim of [
      [`<agent-notes id="b4">`, "    noted", "  </agent-notes>"].join("\n"),
      `<page id="b3"/>`,
      `<agent-page id="b2" title="Findings"/>`,
    ]) {
      const md = `${markdownOf(rows)}\n<agent-page title="New">\n  ${claim}\n</agent-page>`;
      const result = refusal(rows, md);
      expect({ claim, reason: result.reason }).toEqual({
        claim,
        reason: "ref-out-of-scope",
      });
    }
  });

  test("the baseline plans no creates: a minted page reads back as its pointer", () => {
    const rows = withPages();
    const minted = applyPlan(
      rows,
      planOf(rows, `${markdownOf(rows)}\n${MINT}`),
    );
    const md = markdownOf(minted);
    expect(md).toMatch(/<agent-page id="[^"]+" title="New"\/>$/);
    const again = planOf(minted, md);
    expect(again.patch.creates).toEqual([]);
    expect(isEmptyPatch(again.patch)).toBe(true);
  });

  test("an agent page OMITTED from the document is re-homed, never deleted", () => {
    const rows = withPages();
    const md = markdownOf(rows).replace(
      `<agent-page id="b2" title="Findings"/>\n`,
      "",
    );
    const plan = planOf(rows, md);
    expect(plan.patch.deleteIds).toEqual([]);
    expect(plan.patch.updates.map((u) => u.id)).toContain("b2");
  });
});

// ---------------------------------------------------------------------------
// Identified cards: the id is a CLAIM, and every claim is checked
// ---------------------------------------------------------------------------
//
// A sub-page's identity is asserted by the `<page id="…"/>` pointer; an
// identified card's by the reserved `id` on its own tag. One mechanism, one
// refusal vocabulary — these tests are the card half of the sub-page tests
// above, deliberately shaped the same way.

describe("identified cards", () => {
  // b1 "before" | b2 <agent-notes> > b3 "noted" | b4 "after"
  const withCard = (): StoredRow[] =>
    rowsOf([
      raw("text", { text: runs("before") }),
      raw("agent-notes", {}, [raw("text", { text: runs("noted") })]),
      raw("text", { text: runs("after") }),
    ]);

  test("the card carries its ROW ID into the document, and back out", () => {
    const rows = withCard();
    expect(markdownOf(rows)).toContain(`<agent-notes id="b2">`);
    const plan = replan(rows);
    expect(isEmptyPatch(plan.patch)).toBe(true);
    expect(plan.textEdits).toEqual([]);
  });

  test("a card MOVED in the document is repositioned, keeping its id", () => {
    // The pin pass exists for exactly this: an exact-key LCS drops a match whose
    // order crossed, so without it a card that merely moved would arrive as
    // "delete this card and mint another" — detaching its authorship.
    const rows = withCard();
    const md = [
      "before",
      "after",
      `<agent-notes id="b2">`,
      "  noted",
      "</agent-notes>",
    ].join("\n");
    const plan = planOf(rows, md);
    expect(plan.patch.creates).toEqual([]);
    expect(plan.patch.deleteIds).toEqual([]);
    expect(markdownOf(applyPlan(rows, plan))).toBe(md);
  });

  test("a TAGLESS card beside an existing one CREATES — it never steals the id", () => {
    // Both cards are void and carry the byte-identical content key
    // `agent-notes ␀ {}`, so a content-keyed alignment is free to pair the new
    // one with the stored row. Pinning the STORED card unconditionally — even
    // though this document names it — is what makes that impossible.
    const rows = withCard();
    const md = [
      "before",
      `<agent-notes id="b2">`,
      "  noted",
      "</agent-notes>",
      "<agent-notes>",
      "  fresh",
      "</agent-notes>",
      "after",
    ].join("\n");
    const plan = planOf(rows, md);
    expect(plan.patch.deleteIds).toEqual([]);
    expect(plan.patch.creates.map((b) => b.type)).toEqual([
      "agent-notes",
      "text",
    ]);
    // The stored card keeps its row, and the new one is a genuinely new id.
    for (const created of plan.patch.creates) expect(created.id).not.toBe("b2");
    // The document comes back with the minted id filled in — which is the whole
    // point of an identified tag: the card the author asked to CREATE is
    // addressable on the very next read.
    const minted = plan.patch.creates.find((b) => b.type === "agent-notes")!.id;
    expect(markdownOf(applyPlan(rows, plan))).toBe(
      md.replace("<agent-notes>", `<agent-notes id="${minted}">`),
    );
  });

  test("a card the document DROPPED is deleted — there is no shell-style rescue", () => {
    // The asymmetry with a sub-page, stated as a test: a shell owns another
    // partition the document cannot see, a card owns only lines the document
    // shows. So omitting a card is an ordinary, fully-informed delete.
    const rows = withCard();
    const plan = planOf(rows, ["before", "after"].join("\n"));
    expect([...plan.patch.deleteIds].sort()).toEqual(["b2", "b3"]);
  });

  test("an id naming NOTHING is refused — no `create it instead` hatch", () => {
    // `<page id="…"/>` has one, because that tag doubles as an ordinary
    // link-to-page block. An id on an identified tag is only ever an identity
    // claim, so a typo must never quietly become a create.
    const result = planResult(
      withCard(),
      `<agent-notes id="typo">\n  noted\n</agent-notes>`,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unknown-ref");
  });

  test("an id naming a row that carries no id of its own is refused", () => {
    // `b1` is a paragraph: real, in scope, and not addressable — no read ever
    // handed that id out, so claiming it is the same invention as a typo.
    const result = planResult(
      withCard(),
      `<agent-notes id="b1">\n  noted\n</agent-notes>`,
    );
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("unknown-ref");
  });

  test("claiming one card TWICE is refused rather than duplicated", () => {
    const md = [
      `<agent-notes id="b2">`,
      "  noted",
      "</agent-notes>",
      `<agent-notes id="b2">`,
      "  again",
      "</agent-notes>",
    ].join("\n");
    const result = planResult(withCard(), md);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("ref-duplicated");
  });

  test("a card on ANOTHER branch cannot be dragged into a scoped apply", () => {
    // b1 "host" > b2 "inside" | b3 <agent-notes> > b4 "noted"
    const rows = rowsOf([
      raw("text", { text: runs("host") }, [
        raw("text", { text: runs("inside") }),
      ]),
      raw("agent-notes", {}, [raw("text", { text: runs("noted") })]),
    ]);
    const md = [`<agent-notes id="b3">`, "  noted", "</agent-notes>"].join(
      "\n",
    );
    const result = planResult(rows, md, "b1");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("ref-out-of-scope");
  });

  test("a `ref` on a NON-identified type is ignored, not refused", () => {
    // Only the parse of an identified tag ever sets `ref`, so one anywhere else
    // came from a hand-built forest and means nothing to this plan.
    const rows = rowsOf([raw("text", { text: runs("alpha") })]);
    const result = planMarkdownApply({
      rootId: PAGE_ID,
      pageId: PAGE_ID,
      existing: rows,
      incoming: [
        {
          type: "text",
          data: { text: runs("alpha") },
          expanded: true,
          children: [],
          ref: "b1",
        },
      ],
      handles,
    });
    expect(result.ok).toBe(true);
    expect(result.ok && isEmptyPatch(result.plan.patch)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Redaction: invisible to the document, immovable to the plan
// ---------------------------------------------------------------------------

/** The human-audience analogue: a card the read pruned and the agent never saw. */
const redactPrivate: Redact = (rows) =>
  rows.filter((row) => row.type !== "private-notes");

describe("redaction", () => {
  // A / P(hidden) / B, where P's rank is EXACTLY the midpoint of A's and B's —
  // which is what an insertion between A and B mints, byte for byte.
  const withHiddenSibling = (): StoredRow[] => {
    const rows = rowsOf([
      raw("text", { text: runs("alpha") }),
      raw("text", { text: runs("bravo") }),
    ]);
    rows.splice(1, 0, {
      id: "hidden",
      parentId: PAGE_ID,
      type: "private-notes",
      data: {},
      rank: Rank.between(
        Rank.from(rows[0]!.rank),
        Rank.from(rows[1]!.rank),
      ).toJSON(),
      expanded: true,
    });
    return rows;
  };

  test("the hidden row is neither emitted nor deleted", () => {
    const rows = withHiddenSibling();
    const md = markdownOf(redactPrivate(rows));
    expect(md).toBe(["alpha", "bravo"].join("\n"));
    const plan = planOf(rows, md, PAGE_ID, redactPrivate);
    expect(isEmptyPatch(plan.patch)).toBe(true);
  });

  test("T1 — an insert where a hidden row sits does NOT mint its rank", () => {
    // The whole reason `planSiblingRanks` takes obstacles. `Rank.nBetween` is
    // deterministic, so the midpoint of (alpha, bravo) IS the hidden row's key;
    // minting it violates `page_blocks_parent_rank_live_uq` and 500s the apply.
    const rows = withHiddenSibling();
    const hiddenRank = rows.find((row) => row.id === "hidden")!.rank;
    const plan = planOf(
      rows,
      ["alpha", "inserted", "bravo"].join("\n"),
      PAGE_ID,
      redactPrivate,
    );
    expect(plan.patch.creates).toHaveLength(1);
    const minted = String(plan.patch.creates[0]!.rank);
    expect(minted).not.toBe(hiddenRank);
    // The stated bound: it lands AFTER the hidden row, and still before `bravo`.
    expect(Rank.compare(Rank.from(minted), Rank.from(hiddenRank))).toBe(1);
    const bravo = rows.find((row) => row.id === "b2")!;
    expect(Rank.compare(Rank.from(minted), Rank.from(bravo.rank))).toBe(-1);
    // Nothing the document could not see is written, in either channel.
    for (const update of plan.patch.updates)
      expect(update.id).not.toBe("hidden");
    expect(plan.patch.deleteIds).toEqual([]);
  });

  test("the preserved-shell floor clears a hidden TOP-LEVEL row too", () => {
    // The one rank site that does not go through `planSiblingRanks`: a dropped
    // shell is re-homed with `Rank.nBetween(floor, null, n)`, which is just as
    // free to land on a hidden row's key as the midpoint above.
    const rows = rowsOf([
      raw("text", { text: runs("alpha") }),
      raw("page", { title: "Sub", icon: null }),
    ]);
    // The hidden card sits LAST, above everything the document places.
    rows.push({
      id: "hidden",
      parentId: PAGE_ID,
      type: "private-notes",
      data: {},
      rank: Rank.nBetween(Rank.from(rows[1]!.rank), null, 1)[0]!.toJSON(),
      expanded: true,
    });
    const hiddenRank = rows.find((row) => row.id === "hidden")!.rank;
    // The shell is dropped from the document, so it is re-homed above the floor.
    const plan = planOf(rows, "alpha", PAGE_ID, redactPrivate);
    const shellUpdate = plan.patch.updates.find((u) => u.id === "b2")!;
    expect(shellUpdate).toBeDefined();
    expect(String(shellUpdate.changes.rank)).not.toBe(hiddenRank);
    expect(
      Rank.compare(
        Rank.from(String(shellUpdate.changes.rank)),
        Rank.from(hiddenRank),
      ),
    ).toBe(1);
  });

  test("a redaction-pruned card cannot be dragged back in by naming its id", () => {
    // The load-bearing half of `ref-out-of-scope`: the row is real, so it is not
    // `unknown-ref`, and it is invisible to the document's author, so a claim on
    // it is never something they wrote knowingly.
    const rows = rowsOf([
      raw("text", { text: runs("alpha") }),
      raw("private-notes", {}, [raw("text", { text: runs("secret") })]),
    ]);
    const md = [
      "alpha",
      `<private-notes id="b2">`,
      "  secret",
      "</private-notes>",
    ].join("\n");
    const result = planResult(rows, md, PAGE_ID, redactPrivate);
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("ref-out-of-scope");
  });
});

describe("fuzz: a redacted read round-trips to no writes at all", () => {
  test("plan(rows, parse(serialize(redact(rows)))) is empty, over 400 seeds", () => {
    // The new law. "Deletes nothing" is the property that matters — a redacted
    // card must never read as a deletion — but the honest assertion is the
    // stronger one: a faithfully round-tripped redacted read is a NO-OP, so
    // reading a page and writing it straight back cannot cost the human a single
    // row, rank or character of what the agent could not see.
    let exercised = 0;
    for (let seed = 1; seed <= 400; seed++) {
      const rows = fuzzRows(seed);
      if (rows.some((row) => row.type === "private-notes")) exercised += 1;
      const md = markdownOf(redactPrivate(rows));
      const plan = planOf(rows, md, PAGE_ID, redactPrivate);
      expect({ seed, patch: plan.patch }).toEqual({
        seed,
        patch: { creates: [], updates: [], deleteIds: [] },
      });
      expect({ seed, textEdits: plan.textEdits }).toEqual({
        seed,
        textEdits: [],
      });
    }
    expect(exercised).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Minimality of each individual change
// ---------------------------------------------------------------------------

describe("a change names exactly the fields it changes", () => {
  test("a text edit names NO row field at all", () => {
    const rows = rowsOf([
      raw("text", { text: runs("alpha") }),
      raw("text", { text: runs("bravo") }),
    ]);
    const plan = planOf(rows, ["alpha", "bravo tweaked"].join("\n"));
    expect(isEmptyPatch(plan.patch)).toBe(true);
    expect(plan.textEdits).toEqual([
      { blockId: "b2", runs: [{ text: "bravo tweaked" }] },
    ]);
  });

  test("a conversion names `type` and nothing else", () => {
    const rows = rowsOf([raw("text", { text: runs("alpha") })]);
    const plan = planOf(rows, "# alpha");
    expect(plan.patch.updates).toEqual([
      { id: "b1", changes: { type: "heading-1" } },
    ]);
    expect(plan.textEdits).toEqual([]);
  });

  test("a data-only edit names `data`, and its `text` restates the row's own", () => {
    const rows = rowsOf([
      raw("to-do", { text: runs("ship it"), checked: false }),
    ]);
    const plan = planOf(rows, "- [x] ship it");
    expect(plan.patch.updates).toHaveLength(1);
    expect(plan.patch.updates[0]!.changes).toEqual({
      data: { text: runs("ship it"), checked: true },
    });
    expect(plan.textEdits).toEqual([]);
  });

  test("an indent names `parentId` and `rank`, and nothing else moves", () => {
    const rows = rowsOf([
      raw("text", { text: runs("alpha") }),
      raw("text", { text: runs("bravo") }),
    ]);
    const plan = planOf(rows, ["alpha", "  bravo"].join("\n"));
    expect(plan.patch.updates).toHaveLength(1);
    expect(plan.patch.updates[0]!.id).toBe("b2");
    expect(new Set(Object.keys(plan.patch.updates[0]!.changes))).toEqual(
      new Set(["parentId", "rank"]),
    );
  });

  test("inserting a line re-ranks NO sibling", () => {
    const rows = rowsOf([
      raw("text", { text: runs("alpha") }),
      raw("text", { text: runs("bravo") }),
    ]);
    const plan = planOf(rows, ["alpha", "inserted", "bravo"].join("\n"));
    expect(plan.patch.updates).toEqual([]);
    expect(plan.patch.creates).toHaveLength(1);
    expect(plan.patch.creates[0]!.expanded).toBe(true);
    expect(plan.patch.creates[0]!.parentId).toBe(PAGE_ID);
    const created = Rank.from(String(plan.patch.creates[0]!.rank));
    expect(Rank.compare(created, Rank.from(rows[0]!.rank))).toBe(1);
    expect(Rank.compare(created, Rank.from(rows[1]!.rank))).toBe(-1);
  });

  test("a block that MOVED across the document keeps its id", () => {
    // The move shows up as a removal in one alignment gap and an insertion in
    // another, which a gap-local matcher can never pair — this is the whole-
    // document pass.
    const rows = rowsOf([
      raw("text", { text: runs("alpha") }),
      raw("text", { text: runs("bravo") }),
      raw("text", { text: runs("charlie") }),
      raw("text", { text: runs("delta") }),
    ]);
    const plan = planOf(
      rows,
      ["bravo", "charlie", "delta", "alpha"].join("\n"),
    );
    expect(plan.patch.creates).toEqual([]);
    expect(plan.patch.deleteIds).toEqual([]);
    expect(plan.patch.updates.map((u) => u.id)).toEqual(["b1"]);
  });
});

// ---------------------------------------------------------------------------
// Fuzz
// ---------------------------------------------------------------------------

/** Mulberry32 — deterministic, so a failure is reproducible from its seed. */
const rng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

// Words chosen so no generated line can be claimed by a PREFIX parser — the same
// (pre-existing) lossiness of markdown itself `markdown.test.ts` works around.
const words = ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf"];

function pickRuns(r: () => number): RichText {
  const n = 1 + Math.floor(r() * 3);
  const parts: string[] = [];
  for (let i = 0; i < n; i++)
    parts.push(words[Math.floor(r() * words.length)]!);
  const marks = r() < 0.2 ? (["bold"] as const) : undefined;
  return [{ text: parts.join(" "), ...(marks ? { marks: [...marks] } : {}) }];
}

const gens: {
  type: string;
  data(r: () => number): unknown;
  children: boolean;
}[] = [
  { type: "text", data: (r) => ({ text: pickRuns(r) }), children: true },
  {
    type: "bulleted-list",
    data: (r) => ({ text: pickRuns(r) }),
    children: true,
  },
  { type: "heading-1", data: (r) => ({ text: pickRuns(r) }), children: true },
  { type: "toggle", data: (r) => ({ text: pickRuns(r) }), children: true },
  { type: "quote", data: (r) => ({ text: pickRuns(r) }), children: true },
  {
    type: "to-do",
    data: (r) => ({ text: pickRuns(r), checked: r() < 0.5 }),
    children: true,
  },
  { type: "divider", data: () => ({}), children: false },
  {
    type: "code-block",
    data: (r) => ({
      code: `const x = ${Math.floor(r() * 100)};`,
      ...(r() < 0.5 ? { language: "ts" } : {}),
    }),
    children: false,
  },
  {
    type: "callout",
    data: (r) => ({
      icon: r() < 0.5 ? null : "info",
      color: r() < 0.5 ? ("default" as const) : ("info" as const),
    }),
    children: true,
  },
  // The identified cards, WITH children — so `fuzzRows` builds real rows whose
  // ids the serialized document carries, and the two properties below (identity
  // ⇒ no writes; one edit at a time) automatically become the strongest
  // available proof that id-pinning round-trips: the pin has to resolve back to
  // the very row it was minted from, in every position the fuzz puts it in.
  { type: "agent-notes", data: () => ({}), children: true },
  { type: "private-notes", data: () => ({}), children: true },
  { type: "todo", data: () => ({}), children: true },
  {
    type: "image",
    data: (r) => ({
      attachmentId: `att_${Math.floor(r() * 1000)}`,
      ...(r() < 0.5 ? { width: 320 + Math.floor(r() * 640) } : {}),
    }),
    children: false,
  },
  {
    type: "page-link",
    data: (r) => ({ pageId: `p${Math.floor(r() * 99)}` }),
    children: false,
  },
  // A sub-page SHELL: a leaf of this page's forest (its content lives under a
  // different `page_id` partition and is not in these rows at all).
  { type: "page", data: () => ({ title: "Sub", icon: null }), children: false },
  // An agent-authored page's shell: the same leaf, written `<agent-page id
  // title/>` — so the fuzz proves the identified spelling pins back to its row.
  {
    type: "page",
    data: () => ({ title: "Found", icon: null, author: "agent" }),
    children: false,
  },
];

function buildRaw(r: () => number, depth: number): RawNode {
  const gen = gens[Math.floor(r() * gens.length)]!;
  const kids: RawNode[] = [];
  if (gen.children && depth < 3) {
    const n = Math.floor(r() * (depth === 0 ? 3 : 2));
    for (let i = 0; i < n; i++) kids.push(buildRaw(r, depth + 1));
  }
  return { type: gen.type, data: gen.data(r), children: kids };
}

function fuzzRows(seed: number): StoredRow[] {
  const r = rng(seed);
  const forest: RawNode[] = [];
  const roots = 1 + Math.floor(r() * 5);
  for (let i = 0; i < roots; i++) forest.push(buildRaw(r, 0));
  return rowsOf(forest);
}

describe("fuzz: identity ⇒ no writes", () => {
  test("planMarkdownApply(rows, parse(serialize(rows))) is empty, over 400 seeds", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rows = fuzzRows(seed);
      const plan = replan(rows);
      expect({ seed, patch: plan.patch }).toEqual({
        seed,
        patch: { creates: [], updates: [], deleteIds: [] },
      });
      expect({ seed, textEdits: plan.textEdits }).toEqual({
        seed,
        textEdits: [],
      });
      expect({ seed, survived: plan.stats.survived }).toEqual({
        seed,
        survived: rows.length,
      });
    }
  });
});

// --- Edit scripts ----------------------------------------------------------

const clone = (rows: StoredRow[]): StoredRow[] =>
  rows.map((row) => ({ ...row }));
const isShellRow = (row: StoredRow): boolean => row.type === "page";
const isTextRow = (row: StoredRow): boolean =>
  byType.get(row.type)?.text !== undefined;

function subtreeIds(rows: StoredRow[], rootId: string): Set<string> {
  const ids = new Set([rootId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const row of rows) {
      if (row.parentId !== null && ids.has(row.parentId) && !ids.has(row.id)) {
        ids.add(row.id);
        grew = true;
      }
    }
  }
  return ids;
}

function siblingsOf(rows: StoredRow[], parentId: string): StoredRow[] {
  return rows
    .filter((row) => row.parentId === parentId)
    .sort((a, b) => Rank.compare(Rank.from(a.rank), Rank.from(b.rank)));
}

/** A rank placing a row at slot `at` of `parentId`'s sibling list. */
function rankAt(
  rows: StoredRow[],
  parentId: string,
  at: number,
  excludeId?: string,
): string {
  const list = siblingsOf(rows, parentId).filter((row) => row.id !== excludeId);
  const prev = at > 0 ? Rank.from(list[at - 1]!.rank) : null;
  const next = at < list.length ? Rank.from(list[at]!.rank) : null;
  return Rank.between(prev, next).toJSON();
}

const pickFrom = <T>(r: () => number, items: T[]): T | undefined =>
  items.length === 0 ? undefined : items[Math.floor(r() * items.length)];

describe("fuzz: one edit at a time", () => {
  test("retext — the patch is empty and exactly that block gets a text edit", () => {
    let exercised = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 7919);
      const rows = fuzzRows(seed);
      // A row whose text is unique in the document, so "which block was edited"
      // has one answer rather than several equally good ones.
      const target = pickFrom(
        r,
        rows.filter(
          (row) =>
            isTextRow(row) &&
            rows.filter(
              (x) => isTextRow(x) && plainTextOfRow(x) === plainTextOfRow(row),
            ).length === 1,
        ),
      );
      if (!target) continue;
      exercised += 1;
      const edited = clone(rows);
      const row = edited.find((x) => x.id === target.id)!;
      row.data = {
        ...(row.data as object),
        text: runs(`${plainTextOfRow(target)} tweak${seed}`),
      };
      const plan = planOf(rows, markdownOf(edited));
      expect({ seed, patch: plan.patch }).toEqual({
        seed,
        patch: { creates: [], updates: [], deleteIds: [] },
      });
      expect({ seed, ids: plan.textEdits.map((e) => e.blockId) }).toEqual({
        seed,
        ids: [target.id],
      });
      expectConverges(rows, edited, seed);
    }
    expect(exercised).toBeGreaterThan(100);
  });

  test("retype — exactly `type`, for exactly that block", () => {
    let exercised = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 104729);
      const rows = fuzzRows(seed);
      // Only between types sharing `textDataSchema`, so `data` genuinely doesn't
      // change — a to-do would legitimately gain/lose `checked`.
      const plain = ["text", "bulleted-list", "heading-1"];
      const target = pickFrom(
        r,
        rows.filter(
          (row) =>
            plain.includes(row.type) &&
            plainTextOfRow(row).length > 0 &&
            rows.filter((x) => plainTextOfRow(x) === plainTextOfRow(row))
              .length === 1,
        ),
      );
      if (!target) continue;
      const nextType = plain.filter((t) => t !== target.type)[
        Math.floor(r() * 2)
      ]!;
      exercised += 1;
      const edited = clone(rows);
      edited.find((x) => x.id === target.id)!.type = nextType;
      const plan = planOf(rows, markdownOf(edited));
      expect({ seed, updates: plan.patch.updates }).toEqual({
        seed,
        updates: [{ id: target.id, changes: { type: nextType } }],
      });
      expect({
        seed,
        creates: plan.patch.creates.length,
        deletes: plan.patch.deleteIds,
      }).toEqual({ seed, creates: 0, deletes: [] });
      expectConverges(rows, edited, seed);
    }
    expect(exercised).toBeGreaterThan(60);
  });

  test("delete — exactly that subtree, with no other row touched", () => {
    let exercised = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 15485863);
      const rows = fuzzRows(seed);
      // A shell is never deleted by an apply — that case is its own test above.
      const candidates = rows.filter(
        (row) =>
          !isShellRow(row) &&
          ![...subtreeIds(rows, row.id)].some((id) =>
            isShellRow(rows.find((x) => x.id === id)!),
          ),
      );
      const target = pickFrom(r, candidates);
      if (!target) continue;
      exercised += 1;
      const gone = subtreeIds(rows, target.id);
      const edited = rows.filter((row) => !gone.has(row.id));
      const plan = planOf(rows, markdownOf(edited));
      // Exactly as many rows leave as were removed, nothing is created, and no
      // survivor's CONTENT is rewritten. WHICH ids leave is only determined up to
      // content — two identical dividers are interchangeable, and picking the
      // other one costs a placement write instead — so the field assertion is
      // that nothing but placement moves.
      expect({ seed, deleted: plan.patch.deleteIds.length }).toEqual({
        seed,
        deleted: gone.size,
      });
      expect({
        seed,
        creates: plan.patch.creates,
        texts: plan.textEdits,
      }).toEqual({
        seed,
        creates: [],
        texts: [],
      });
      const fields = [...namedFields(plan.patch)].sort();
      expect({ seed, fields }).toEqual({
        seed,
        fields: fields.filter((f) => f === "parentId" || f === "rank"),
      });
      expectConverges(rows, edited, seed);
    }
    expect(exercised).toBeGreaterThan(100);
  });

  test("insert — one create, no sibling re-ranked", () => {
    let exercised = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 32452843);
      const rows = fuzzRows(seed);
      const parents: string[] = [
        PAGE_ID,
        ...rows
          .filter((row) => !isShellRow(row) && isTextRow(row))
          .map((row) => row.id),
      ];
      const parentId = pickFrom(r, parents)!;
      const at = Math.floor(r() * (siblingsOf(rows, parentId).length + 1));
      exercised += 1;
      const edited = clone(rows);
      edited.push({
        id: "NEW",
        parentId,
        type: "text",
        data: { text: runs(`freshly inserted line ${seed}`) },
        rank: rankAt(edited, parentId, at),
        expanded: true,
      });
      const plan = planOf(rows, markdownOf(edited));
      expect({
        seed,
        updates: plan.patch.updates,
        deletes: plan.patch.deleteIds,
      }).toEqual({
        seed,
        updates: [],
        deletes: [],
      });
      expect({ seed, creates: plan.patch.creates.length }).toEqual({
        seed,
        creates: 1,
      });
      expect({ seed, parent: plan.patch.creates[0]!.parentId }).toEqual({
        seed,
        parent: parentId,
      });
      expectConverges(rows, edited, seed);
    }
    expect(exercised).toBeGreaterThan(150);
  });

  test("move — one update naming only placement, nothing created or deleted", () => {
    let exercised = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 49979687);
      const rows = fuzzRows(seed);
      // A leaf whose plain text is unique in the document, so the whole-document
      // pass has an unambiguous partner to re-pair it with.
      const leaves = rows.filter(
        (row) =>
          !isShellRow(row) &&
          isTextRow(row) &&
          plainTextOfRow(row).length > 0 &&
          rows.filter((x) => plainTextOfRow(x) === plainTextOfRow(row))
            .length === 1 &&
          !rows.some((x) => x.parentId === row.id),
      );
      const target = pickFrom(r, leaves);
      if (!target) continue;
      const destinations = [
        PAGE_ID,
        ...rows
          .filter(
            (row) => row.id !== target.id && !isShellRow(row) && isTextRow(row),
          )
          .map((row) => row.id),
      ];
      const parentId = pickFrom(r, destinations)!;
      const edited = clone(rows);
      const moved = edited.find((x) => x.id === target.id)!;
      const slots = siblingsOf(edited, parentId).filter(
        (x) => x.id !== target.id,
      ).length;
      const at = Math.floor(r() * (slots + 1));
      const rank = rankAt(edited, parentId, at, target.id);
      if (parentId === moved.parentId && rank === moved.rank) continue;
      moved.parentId = parentId;
      moved.rank = rank;
      if (markdownOf(edited) === markdownOf(rows)) continue;
      exercised += 1;
      const plan = planOf(rows, markdownOf(edited));
      expect({
        seed,
        creates: plan.patch.creates,
        deletes: plan.patch.deleteIds,
      }).toEqual({
        seed,
        creates: [],
        deletes: [],
      });
      const fields = [...namedFields(plan.patch)].sort();
      expect({ seed, fields }).toEqual({
        seed,
        fields: fields.filter((f) => f === "parentId" || f === "rank"),
      });
      expectConverges(rows, edited, seed);
    }
    expect(exercised).toBeGreaterThan(80);
  });
});

// ---------------------------------------------------------------------------
// The two survivor invariants, asserted over everything the fuzz produces
// ---------------------------------------------------------------------------

describe("survivor invariants", () => {
  test("`expanded` is NEVER named for a survivor, over every fuzzed edit", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 86028121);
      const rows = fuzzRows(seed);
      const edited = clone(rows);
      // One arbitrary mutation of each shape, all at once — a worst case rather
      // than a single edit, so the invariant is tested against real churn.
      const textRow = pickFrom(r, edited.filter(isTextRow));
      if (textRow) {
        textRow.data = {
          ...(textRow.data as object),
          text: runs(`rewritten ${seed}`),
        };
      }
      const doomed = pickFrom(
        r,
        edited.filter((row) => !isShellRow(row)),
      );
      const survivors = doomed
        ? edited.filter((row) => !subtreeIds(edited, doomed.id).has(row.id))
        : edited;
      const plan = planOf(rows, markdownOf(survivors));
      for (const update of plan.patch.updates) {
        expect({
          seed,
          id: update.id,
          expanded: namesField(update.changes, "expanded"),
        }).toEqual({ seed, id: update.id, expanded: false });
      }
    }
  });

  test("a survivor's `data` always restates the row's OWN text", () => {
    for (let seed = 1; seed <= 150; seed++) {
      const r = rng(seed * 122949829);
      const rows = fuzzRows(seed);
      const edited = clone(rows);
      const toggled = pickFrom(
        r,
        edited.filter((row) => row.type === "to-do"),
      );
      if (toggled) {
        toggled.data = {
          ...(toggled.data as { checked: boolean }),
          checked: !(toggled.data as { checked: boolean }).checked,
        };
      }
      const textRow = pickFrom(r, edited.filter(isTextRow));
      if (textRow) {
        textRow.data = {
          ...(textRow.data as object),
          text: runs(`rewritten ${seed}`),
        };
      }
      const plan = planOf(rows, markdownOf(edited));
      for (const update of plan.patch.updates) {
        if (!namesField(update.changes, "data")) continue;
        const before = rows.find((row) => row.id === update.id)!;
        expect({
          seed,
          id: update.id,
          text: plainOf(
            runsOf((update.changes.data as { text?: unknown }).text),
          ),
        }).toEqual({
          seed,
          id: update.id,
          text: plainOf(runsOf((before.data as { text?: unknown }).text)),
        });
      }
    }
  });
});

// ---------------------------------------------------------------------------
// A NON-PAGE root
// ---------------------------------------------------------------------------
//
// `existing` still carries the whole page partition (the rank floor and the
// sub-page pin both need rows the walk may not reach), so what bounds the plan
// is the WALK, not the input. These tests are the executable statement of that:
// whatever the incoming document says, a row the walk did not reach is neither
// updated nor deleted, and the root itself is scope rather than content.

describe("a non-page root bounds every authority", () => {
  // b1 "before" | b2 callout > (b3 "inside one", b4 "inside two") | b5 "after"
  const nested = (): StoredRow[] =>
    rowsOf([
      raw("text", { text: runs("before") }),
      raw("callout", { icon: null, color: "default" }, [
        raw("text", { text: runs("inside one") }),
        raw("bulleted-list", { text: runs("inside two") }),
      ]),
      raw("text", { text: runs("after") }),
    ]);
  const OUTSIDE = ["b1", "b2", "b5"];
  const outsideRows = (rows: StoredRow[]): StoredRow[] =>
    rows.filter((row) => OUTSIDE.includes(row.id));

  test("the root's document is its CONTENT — the root has no line in it", () => {
    const md = markdownOf(nested(), "b2");
    expect(md).toContain("inside one");
    expect(md).toContain("inside two");
    expect(md).not.toContain("before");
    expect(md).not.toContain("after");
    expect(md).not.toContain("callout");
  });

  test("re-applying the root's OWN document emits nothing", () => {
    const rows = nested();
    const plan = planOf(rows, markdownOf(rows, "b2"), "b2");
    expect(isEmptyPatch(plan.patch)).toBe(true);
    expect(plan.textEdits).toEqual([]);
  });

  test("emptying the subtree deletes ITS rows and no others", () => {
    // The whole document is gone, which at the page root would empty the page.
    // Here it is a two-row delete, because `deleteIds` derives from the WALK.
    const plan = planOf(nested(), "", "b2");
    expect([...plan.patch.deleteIds].sort()).toEqual(["b3", "b4"]);
    expect(plan.patch.creates).toEqual([]);
    expect(plan.patch.updates).toEqual([]);
  });

  test("replacing the subtree wholesale names nothing outside it, nor the root", () => {
    const rows = nested();
    const md = ["fresh alpha", "fresh bravo", "fresh charlie"].join("\n");
    const plan = planOf(rows, md, "b2");
    const named = new Set<string>([
      ...plan.patch.deleteIds,
      ...plan.patch.updates.map((u) => u.id),
      ...plan.textEdits.map((e) => e.blockId),
    ]);
    for (const id of named) expect(["b3", "b4"]).toContain(id);
    // A created row joins the PAGE's partition (`pageId` is a partition, not a
    // position) and hangs off the ROOT (the parent of a top-level node).
    for (const created of plan.patch.creates) {
      expect(created.pageId).toBe(PAGE_ID);
      expect(created.parentId).toBe("b2");
    }
    const after = applyPlan(rows, plan);
    expect(markdownOf(after, "b2")).toBe(md);
    expect(outsideRows(after)).toEqual(outsideRows(rows));
  });

  // b1 "before" | b2 callout > (b3 "inside one", b4 SHELL) | b5 "after"
  const withNestedShell = (): StoredRow[] =>
    rowsOf([
      raw("text", { text: runs("before") }),
      raw("callout", { icon: null, color: "default" }, [
        raw("text", { text: runs("inside one") }),
        raw("page", { title: "Sub", icon: null }),
      ]),
      raw("text", { text: runs("after") }),
    ]);

  test("a shell INSIDE the root round-trips through the scoped document", () => {
    const rows = withNestedShell();
    const plan = planOf(rows, markdownOf(rows, "b2"), "b2");
    expect(isEmptyPatch(plan.patch)).toBe(true);
  });

  test("an identified card INSIDE the root round-trips the same way", () => {
    // The card twin of the test above: a pin resolves against the WALK, so a
    // card the scoped read emitted must pin back to its own row at that depth —
    // an id is not a page-level address that only works from the page root.
    const rows = rowsOf([
      raw("text", { text: runs("before") }),
      raw("callout", { icon: null, color: "default" }, [
        raw("text", { text: runs("inside one") }),
        raw("agent-notes", {}, [raw("text", { text: runs("noted") })]),
      ]),
      raw("text", { text: runs("after") }),
    ]);
    expect(markdownOf(rows, "b2")).toContain(`<agent-notes id="b4">`);
    const plan = planOf(rows, markdownOf(rows, "b2"), "b2");
    expect(isEmptyPatch(plan.patch)).toBe(true);
    expect(plan.textEdits).toEqual([]);
  });

  test("a shell the scoped document DROPPED is refused, never re-homed", () => {
    // Re-homing preserves a dropped shell by lifting it to the root, which is
    // right when the root IS the page and would drag a whole page tree INTO the
    // addressed block when it is not.
    const result = planResult(withNestedShell(), "inside one", "b2");
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toBe("subpage-removed");
  });

  test("the SAME omission at the page root is still a re-home", () => {
    // The two roots differ here and nowhere else; pinning both sides is what
    // keeps the refusal from quietly becoming the general answer.
    const rows = withNestedShell();
    const plan = planOf(
      rows,
      markdownOf(rows.filter((row) => row.id !== "b4")),
    );
    expect(plan.patch.deleteIds).toEqual([]);
    expect(
      plan.patch.updates.find((u) => u.id === "b4")?.changes.parentId,
    ).toBe(PAGE_ID);
  });
});

describe("fuzz: a non-page root, over the same edits", () => {
  /** A root with content of its own and no sub-page shell anywhere below it. */
  function pickRoot(r: () => number, rows: StoredRow[]): StoredRow | undefined {
    const byId = new Map(rows.map((row) => [row.id, row] as const));
    return pickFrom(
      r,
      rows.filter((row) => {
        const ids = subtreeIds(rows, row.id);
        // A dropped shell under a non-page root is a REFUSAL, tested above; the
        // fuzz is about plans, so it works over shell-free subtrees.
        return (
          ids.size > 1 && ![...ids].some((id) => isShellRow(byId.get(id)!))
        );
      }),
    );
  }

  test("nothing outside the root moves, and the survivor invariants still hold", () => {
    let exercised = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const r = rng(seed * 217645199);
      const rows = fuzzRows(seed);
      const root = pickRoot(r, rows);
      if (!root) continue;
      const inside = subtreeIds(rows, root.id);
      const reachable = (id: string): boolean =>
        inside.has(id) && id !== root.id;

      // A worst case rather than a single edit — rewrite one text row inside the
      // subtree AND drop a whole subtree inside it — so the plan has real churn
      // to be minimal about.
      const edited = clone(rows);
      const textRow = pickFrom(
        r,
        edited.filter((row) => isTextRow(row) && reachable(row.id)),
      );
      if (textRow) {
        textRow.data = {
          ...(textRow.data as object),
          text: runs(`rewritten ${seed}`),
        };
      }
      const doomed = pickFrom(
        r,
        edited.filter((row) => reachable(row.id)),
      );
      const survivors = doomed
        ? edited.filter((row) => !subtreeIds(edited, doomed.id).has(row.id))
        : edited;
      exercised += 1;
      const plan = planOf(rows, markdownOf(survivors, root.id), root.id);

      for (const id of [
        ...plan.patch.deleteIds,
        ...plan.patch.updates.map((u) => u.id),
        ...plan.textEdits.map((e) => e.blockId),
      ]) {
        expect({ seed, root: root.id, id, reachable: reachable(id) }).toEqual({
          seed,
          root: root.id,
          id,
          reachable: true,
        });
      }
      for (const update of plan.patch.updates) {
        expect({
          seed,
          id: update.id,
          expanded: namesField(update.changes, "expanded"),
        }).toEqual({ seed, id: update.id, expanded: false });
        if (!namesField(update.changes, "data")) continue;
        const before = rows.find((row) => row.id === update.id)!;
        expect({
          seed,
          id: update.id,
          text: plainOf(
            runsOf((update.changes.data as { text?: unknown }).text),
          ),
        }).toEqual({
          seed,
          id: update.id,
          text: plainOf(runsOf((before.data as { text?: unknown }).text)),
        });
      }
      for (const created of plan.patch.creates) {
        expect({ seed, pageId: created.pageId }).toEqual({
          seed,
          pageId: PAGE_ID,
        });
      }

      // The complement, stated positively: every row the walk could not reach is
      // byte-identical after the plan is applied.
      const outside = (list: StoredRow[]): StoredRow[] =>
        list.filter((row) => !reachable(row.id));
      expect({ seed, outside: outside(applyPlan(rows, plan)) }).toEqual({
        seed,
        outside: outside(rows),
      });
      expectConverges(rows, survivors, seed, root.id);
    }
    expect(exercised).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// Inert blocks: left exactly as stored, on both sides of the diff
// ---------------------------------------------------------------------------

describe("inert blocks (core/inert.ts)", () => {
  const isEmptyText = (type: string, data: unknown): boolean =>
    type === "text" &&
    plainOf(runsOf((data as { text?: unknown }).text)) === "";
  /**
   * The shape of `agent-access`'s policy, over this fixture: an empty paragraph
   * is inert unless an `agent-notes` card holds it. Everything here is at the
   * page root, so a stored row's parent IS its whole chain.
   */
  const inert: InertBlocks = {
    row: (row) => isEmptyText(row.type, row.data) && row.parentId === PAGE_ID,
    node: (node, ancestors) =>
      isEmptyText(node.type, node.data) &&
      node.children.length === 0 &&
      !ancestors.some((a) => a.type === "agent-notes"),
  };
  /** What `applyToScope` does with an `inert` option: both sides, one answer. */
  const planInert = (rows: StoredRow[], md: string) => {
    const { forest, dropped } = dropInertNodes(
      parseMarkdownToForest(md, ctx),
      inert.node,
    );
    const result = planMarkdownApply({
      rootId: PAGE_ID,
      pageId: PAGE_ID,
      existing: rows,
      incoming: forest,
      handles,
      redact: (all) => dropInertRows(all, inert.row),
    });
    if (!result.ok) throw new Error(`refused: ${result.detail}`);
    return { plan: result.plan, dropped };
  };
  // A, an empty paragraph, B.
  const rows = rowsOf([
    raw("text", { text: runs("A") }),
    raw("text", { text: [] }),
    raw("text", { text: runs("B") }),
  ]);
  const card = "<agent-notes>\n  note\n</agent-notes>";
  const orderAfter = (plan: MarkdownApplyPlan): string[] =>
    documentOrderRows(applyPlan(rows, plan), PAGE_ID).map((row) =>
      row.type === "text" ? plainTextOfRow(row) || "(empty)" : row.type,
    );
  const textOf = (data: unknown): string =>
    plainOf(runsOf((data as { text?: unknown }).text));

  test("the read's own document plans nothing", () => {
    const { plan, dropped } = planInert(rows, markdownOf(rows));
    expect(isEmptyPatch(plan.patch)).toBe(true);
    expect(plan.textEdits).toEqual([]);
    expect(dropped).toBe(1);
  });

  test("an empty paragraph ADDED beside a new card is not created", () => {
    // The edit that was refused in the wild: the existing spacer echoed, the
    // card, and a SECOND `<text/>` after it.
    const { plan, dropped } = planInert(
      rows,
      `A\n<text/>\n${card}\n<text/>\nB`,
    );
    expect(plan.patch.creates.map((b) => b.type).sort()).toEqual([
      "agent-notes",
      "text",
    ]);
    expect(
      textOf(plan.patch.creates.find((b) => b.type === "text")!.data),
    ).toBe("note");
    expect(plan.patch.deleteIds).toEqual([]);
    expect(dropped).toBe(2);
    expect(orderAfter(plan)).toEqual([
      "A",
      "(empty)",
      "agent-notes",
      "note",
      "B",
    ]);
  });

  test("an empty paragraph LEFT OUT is kept, and nothing is minted onto its rank", () => {
    const { plan } = planInert(rows, `A\n${card}\nB`);
    expect(plan.patch.deleteIds).toEqual([]);
    const top = applyPlan(rows, plan).filter((row) => row.parentId === PAGE_ID);
    expect(new Set(top.map((row) => row.rank)).size).toBe(top.length);
    // Inserted where the hidden row sits, so it lands after it (ranks.ts).
    expect(orderAfter(plan)).toEqual([
      "A",
      "(empty)",
      "agent-notes",
      "note",
      "B",
    ]);
  });

  test("an empty paragraph inside the card is the card's own line", () => {
    const { plan } = planInert(
      rows,
      `A\n<text/>\n<agent-notes>\n  note\n  <text/>\n  more\n</agent-notes>\nB`,
    );
    expect(plan.patch.creates.map((b) => b.type)).toEqual([
      "agent-notes",
      "text",
      "text",
      "text",
    ]);
  });

  test("text in an inert position is still planned — only EMPTY is inert", () => {
    const { plan } = planInert(rows, "A\n<text/>\nnew prose\nB");
    expect(plan.patch.creates.map((b) => textOf(b.data))).toEqual([
      "new prose",
    ]);
  });

  test("an inert block with children throws on either side", () => {
    const leaf = {
      type: "text",
      data: { text: [] },
      expanded: true,
      children: [],
    };
    const parent = { ...leaf, type: "toggle", children: [leaf] };
    expect(() => dropInertNodes([parent], () => true)).toThrow(/Only a leaf/);
    const nested = rowsOf([
      raw("toggle", { text: [] }, [raw("text", { text: [] })]),
    ]);
    expect(() => dropInertRows(nested, () => true)).toThrow(/Only a leaf/);
  });
});
