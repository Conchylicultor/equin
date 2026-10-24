/**
 * Real-DB suite for the instructions scope and delivery, driven against a
 * throwaway Postgres (db-test-fixture) with the REAL migration chain.
 *
 * What it pins (research/2026-09-17-page-agent-instructions.md §3):
 *  - a card on an ancestor page covers every page below it, root-first;
 *  - an instructions page covers its PARENT page's subtree, itself included;
 *  - a sibling subtree is not covered;
 *  - a link-to-page block pointing at an instructions page makes it cover the
 *    page the link sits on (once, at its root-most cover), unless the link is
 *    withheld;
 *  - an instructions card inside a private card is never delivered, and a
 *    private card inside instructions is redacted out of the rendered markdown;
 *  - `globalInstructions` finds global cards and pages anywhere;
 *  - a delivery counts only at its content hash: an edit makes it pending again.
 *
 * Run: `./equin test plugins/page/plugins/annotations/plugins/instructions`
 * (requires the running embedded cluster, and a `./equin build` that has
 * generated the `page_instructions_deliveries` migration).
 */

import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { pageBlockHandle } from "@plugins/page/plugins/editor/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { textBlock } from "@plugins/page/plugins/text/core";
import { pageLinkBlock } from "@plugins/page/plugins/page-link/core";
import { privateNotesBlock } from "@plugins/page/plugins/annotations/plugins/private-notes/core";
import { instructionsBlock } from "../../core";
import {
  globalInstructions,
  instructionsInScope,
  type InstructionsRef,
} from "./scope";
import { renderForDelivery, renderInstructions } from "./delivery";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "instructions_scope_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  collectContributions([
    {
      id: "instructions-scope-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlock),
        Editor.BlockData(instructionsBlock),
        Editor.BlockData(privateNotesBlock),
        Editor.BlockData(pageLinkBlock),
      ],
    },
  ]);
  await t.db.execute(sql`DELETE FROM page_instructions_deliveries`);
  await t.db.execute(sql`DELETE FROM page_blocks`);
  await seed();
});

// ── Seed ───────────────────────────────────────────────────────────────────

interface Row {
  id: string;
  parent: string | null;
  page: string | null;
  type: string;
  rank: string;
  data: unknown;
}

const text = (s: string) => ({ text: [{ text: s }] });

/**
 * ROOT (page)
 * ├── IR  <instructions>           "root rule"   + a private card inside it
 * ├── PV  <private-note>
 * │   └── IPV <instructions>       "secret rule" — withheld, never delivered
 * ├── TRACKS (page)
 * │   ├── TI  instructions page    "track rules"
 * │   └── TRACK (page)             — "a track"
 * └── OTHER (page)
 *     └── IO  <instructions>       "other rule"
 */
const ROWS: Row[] = [
  {
    id: "ROOT",
    parent: null,
    page: null,
    type: "page",
    rank: "a0",
    data: { title: "Root", icon: null },
  },
  {
    id: "IR",
    parent: "ROOT",
    page: "ROOT",
    type: "instructions",
    rank: "a0",
    data: {},
  },
  {
    id: "IR-1",
    parent: "IR",
    page: "ROOT",
    type: "text",
    rank: "a0",
    data: text("root rule"),
  },
  {
    id: "IR-PV",
    parent: "IR",
    page: "ROOT",
    type: "private-note",
    rank: "a1",
    data: {},
  },
  {
    id: "IR-PV-1",
    parent: "IR-PV",
    page: "ROOT",
    type: "text",
    rank: "a0",
    data: text("hidden aside"),
  },
  {
    id: "PV",
    parent: "ROOT",
    page: "ROOT",
    type: "private-note",
    rank: "a1",
    data: {},
  },
  {
    id: "IPV",
    parent: "PV",
    page: "ROOT",
    type: "instructions",
    rank: "a0",
    data: {},
  },
  {
    id: "IPV-1",
    parent: "IPV",
    page: "ROOT",
    type: "text",
    rank: "a0",
    data: text("secret rule"),
  },
  {
    id: "TRACKS",
    parent: "ROOT",
    page: "ROOT",
    type: "page",
    rank: "a2",
    data: { title: "Current tracks", icon: null },
  },
  {
    id: "TI",
    parent: "TRACKS",
    page: "TRACKS",
    type: "page",
    rank: "a0",
    data: { title: "Track instructions", icon: null, instructions: true },
  },
  {
    id: "TI-1",
    parent: "TI",
    page: "TI",
    type: "text",
    rank: "a0",
    data: text("track rules"),
  },
  {
    id: "TRACK",
    parent: "TRACKS",
    page: "TRACKS",
    type: "page",
    rank: "a1",
    data: { title: "A track", icon: null },
  },
  {
    id: "TRACK-1",
    parent: "TRACK",
    page: "TRACK",
    type: "text",
    rank: "a0",
    data: text("a track"),
  },
  {
    id: "OTHER",
    parent: "ROOT",
    page: "ROOT",
    type: "page",
    rank: "a3",
    data: { title: "Other", icon: null },
  },
  {
    id: "IO",
    parent: "OTHER",
    page: "OTHER",
    type: "instructions",
    rank: "a0",
    data: {},
  },
  {
    id: "IO-1",
    parent: "IO",
    page: "OTHER",
    type: "text",
    rank: "a0",
    data: text("other rule"),
  },
];

async function seed(): Promise<void> {
  for (const r of ROWS) await insert(r);
}

async function insert(r: Row): Promise<void> {
  await t.db.execute(
    sql`INSERT INTO page_blocks (id, parent_id, page_id, type, rank, data)
        VALUES (${r.id}, ${r.parent}, ${r.page}, ${r.type}, ${r.rank},
                ${JSON.stringify(r.data)}::jsonb)`,
  );
}

/** A link-to-page block `id` on `page` (under `parent`, default the page) → `target`. */
const link = (
  id: string,
  page: string,
  target: string,
  parent = page,
  rank = "z0",
): Row => ({
  id,
  parent,
  page,
  type: "page-link",
  rank,
  data: { pageId: target },
});

async function setData(id: string, data: unknown): Promise<void> {
  await t.db.execute(
    sql`UPDATE page_blocks SET data = ${JSON.stringify(data)}::jsonb WHERE id = ${id}`,
  );
}

const ids = (refs: { id: string }[]) => refs.map((r) => r.id);

// The functions take a `DbExecutor` (the process db or a transaction); the
// throwaway is driven through one transaction per call, as page-content's suite
// drives `serializePageContent`.
const inScope = (pageId: string) =>
  t.db.transaction((tx) => instructionsInScope(pageId, tx));
const globals = () => t.db.transaction((tx) => globalInstructions(tx));
const render = (refs: InstructionsRef[]) =>
  t.db.transaction((tx) => renderInstructions(refs, tx));
/** Render for delivery, marking the pending set delivered when `mark`. */
const deliver = (
  conversationId: string,
  refs: InstructionsRef[],
  mark = false,
) =>
  t.db.transaction(async (tx) => {
    const d = await renderForDelivery(conversationId, refs, tx);
    if (mark) await d.markDelivered();
    return { rendered: d.rendered, pending: d.pending };
  });

// ── instructionsInScope ────────────────────────────────────────────────────

describe("instructionsInScope", () => {
  test("a page deep in the tree gets the ancestor card and its parent's instructions page, root-first", async () => {
    const refs = await inScope("TRACK");
    expect(ids(refs)).toEqual(["IR", "TI"]);
    expect(refs[0]).toEqual({
      id: "IR",
      form: "card",
      global: false,
      title: null,
      covers: { pageId: "ROOT", title: "Root" },
    });
    expect(refs[1]).toEqual({
      id: "TI",
      form: "page",
      global: false,
      title: "Track instructions",
      covers: { pageId: "TRACKS", title: "Current tracks" },
    });
  });

  test("an instructions page is in its own scope", async () => {
    expect(ids(await inScope("TI"))).toEqual(["IR", "TI"]);
  });

  test("the page an instructions page sits in is covered by it", async () => {
    expect(ids(await inScope("TRACKS"))).toEqual(["IR", "TI"]);
  });

  test("a sibling subtree is not covered — Other gets its own card, not the track instructions", async () => {
    expect(ids(await inScope("OTHER"))).toEqual(["IR", "IO"]);
  });

  test("a card inside a private card is never in scope", async () => {
    expect(ids(await inScope("ROOT"))).toEqual(["IR"]);
  });

  test("a trashed card drops out", async () => {
    await t.db.execute(
      sql`UPDATE page_blocks SET deleted_at = now(), trash_entry_id = 'trash-test' WHERE id IN ('IR', 'IR-1', 'IR-PV', 'IR-PV-1')`,
    );
    expect(ids(await inScope("TRACK"))).toEqual(["TI"]);
  });

  test("a linked instructions page covers the page the link sits on", async () => {
    await insert(link("L-OTHER", "OTHER", "TI"));
    const refs = await inScope("OTHER");
    expect(ids(refs)).toEqual(["IR", "IO", "TI"]);
    expect(refs[2]!.covers).toEqual({ pageId: "OTHER", title: "Other" });
  });

  test("a linked instructions page reaches pages below the link", async () => {
    await insert({
      id: "SUB",
      parent: "OTHER",
      page: "OTHER",
      type: "page",
      rank: "b0",
      data: { title: "Sub", icon: null },
    });
    await insert(link("L-OTHER", "OTHER", "TI"));
    expect(ids(await inScope("SUB"))).toEqual(["IR", "IO", "TI"]);
  });

  test("an instructions page reached twice is returned once, at its root-most cover", async () => {
    await insert(link("L-ROOT", "ROOT", "TI"));
    await insert(link("L-TRACK", "TRACK", "TI"));
    const refs = await inScope("TRACK");
    expect(ids(refs)).toEqual(["IR", "TI"]);
    expect(refs[1]!.covers).toEqual({ pageId: "ROOT", title: "Root" });
  });

  test("a link inside a private card is never followed", async () => {
    await insert(link("L-PV", "ROOT", "TI", "PV"));
    expect(ids(await inScope("OTHER"))).toEqual(["IR", "IO"]);
  });

  test("a link to an ordinary page, or a trashed link, brings nothing", async () => {
    await insert(link("L-PLAIN", "OTHER", "TRACK"));
    await insert(link("L-GONE", "OTHER", "TI", "OTHER", "z1"));
    await t.db.execute(
      sql`UPDATE page_blocks SET deleted_at = now(), trash_entry_id = 'trash-test' WHERE id = 'L-GONE'`,
    );
    expect(ids(await inScope("OTHER"))).toEqual(["IR", "IO"]);
  });

  test("an unknown page has nothing in scope", async () => {
    expect(await inScope("nope")).toEqual([]);
  });
});

// ── globalInstructions ─────────────────────────────────────────────────────

describe("globalInstructions", () => {
  test("finds global cards and global pages anywhere, and nothing else", async () => {
    expect(await globals()).toEqual([]);
    await setData("IO", { global: true });
    await setData("TI", {
      title: "Track instructions",
      icon: null,
      instructions: true,
      global: true,
    });
    await setData("IPV", { global: true });
    const refs = await globals();
    // IPV sits inside a private card: never delivered, global or not.
    expect(ids(refs).sort()).toEqual(["IO", "TI"]);
    expect(refs.every((r) => r.global)).toBe(true);
  });
});

// ── rendering and delivery ─────────────────────────────────────────────────

describe("renderInstructions", () => {
  test("a card renders its content with private subtrees redacted; a page renders its document", async () => {
    const [card, page] = await render(await inScope("TRACK"));
    expect(card!.markdown).toContain("root rule");
    expect(card!.markdown).not.toContain("hidden aside");
    expect(page!.markdown).toContain("Track instructions");
    expect(page!.markdown).toContain("track rules");
    expect(card!.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("renderForDelivery", () => {
  test("pending until marked; an edit to the instructions makes that block pending again", async () => {
    const refs = await inScope("TRACK");

    const first = await deliver("conv-1", refs, true);
    expect(ids(first.pending)).toEqual(["IR", "TI"]);

    const second = await deliver("conv-1", refs);
    expect(second.pending).toEqual([]);
    expect(ids(second.rendered)).toEqual(["IR", "TI"]);
    // Another conversation has received nothing.
    expect(ids((await deliver("conv-2", refs)).pending)).toEqual(["IR", "TI"]);

    await setData("IR-1", text("root rule, revised"));
    const third = await deliver("conv-1", refs, true);
    expect(ids(third.pending)).toEqual(["IR"]);
    expect(third.pending[0]!.markdown).toContain("revised");
    expect((await deliver("conv-1", refs)).pending).toEqual([]);
  });

  test("editing text inside a redacted private card does not make the instructions stale", async () => {
    const refs = await inScope("TRACK");
    await deliver("conv-1", refs, true);
    await setData("IR-PV-1", text("a different aside"));
    expect((await deliver("conv-1", refs)).pending).toEqual([]);
  });
});
