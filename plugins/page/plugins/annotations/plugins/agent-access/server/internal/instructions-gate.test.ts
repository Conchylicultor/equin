/**
 * Real-DB suite for how the page tools deliver instructions: the read preamble
 * (and what it leaves out because the read already shows it), the write refusal
 * that delivers, the refusal coming back after an edit, and the connect-time
 * global section.
 *
 * Run: `./singularity test plugins/page/plugins/annotations/plugins/agent-access`
 * (requires the running embedded cluster, and a `./singularity build` that has
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
import { HttpError } from "@plugins/infra/plugins/endpoints/server";
import { pageBlockHandle } from "@plugins/page/plugins/editor/core";
import { Editor } from "@plugins/page/plugins/editor/server";
import { textBlock } from "@plugins/page/plugins/text/core";
import { readBlockAsMarkdown } from "@plugins/page/plugins/markdown-apply/server";
import { instructionsBlock } from "@plugins/page/plugins/annotations/plugins/instructions/core";
import {
  assertInstructionsReceived,
  deliverWithRead,
  renderGlobalSection,
  restoreAfterCompaction,
} from "./instructions-gate";
import { redactHumanAudience } from "./policy";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "instructions_gate_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  collectContributions([
    {
      id: "instructions-gate-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlock),
        Editor.BlockData(instructionsBlock),
      ],
    },
  ]);
  await t.db.execute(sql`DELETE FROM page_instructions_deliveries`);
  await t.db.execute(sql`DELETE FROM page_blocks`);
  for (const r of ROWS) {
    await t.db.execute(
      sql`INSERT INTO page_blocks (id, parent_id, page_id, type, rank, data)
          VALUES (${r.id}, ${r.parent}, ${r.page}, ${r.type}, ${r.rank},
                  ${JSON.stringify(r.data)}::jsonb)`,
    );
  }
});

const text = (s: string) => ({ text: [{ text: s }] });

/**
 * ROOT (page)                      — "root prose"
 * ├── IR  <instructions>           "root rule"
 * └── TRACKS (page)
 *     ├── TI  instructions page    "track rules"
 *     └── TRACK (page)             "a track"
 */
const ROWS = [
  {
    id: "ROOT",
    parent: null,
    page: null,
    type: "page",
    rank: "a0",
    data: { title: "Root", icon: null },
  },
  {
    id: "ROOT-1",
    parent: "ROOT",
    page: "ROOT",
    type: "text",
    rank: "a0",
    data: text("root prose"),
  },
  {
    id: "IR",
    parent: "ROOT",
    page: "ROOT",
    type: "instructions",
    rank: "a1",
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
];

async function setData(id: string, data: unknown): Promise<void> {
  await t.db.execute(
    sql`UPDATE page_blocks SET data = ${JSON.stringify(data)}::jsonb WHERE id = ${id}`,
  );
}

/** What `read_page` prepends for a read rooted at `blockId` in `pageId`. */
async function read(
  conversationId: string,
  blockId: string,
  pageId: string,
): Promise<{ preamble: string; body: string }> {
  // The functions take a `DbExecutor` (the process db or a transaction); the
  // throwaway is driven through one transaction per call, as the instructions
  // plugin's own suite does.
  return t.db.transaction(async (tx) => {
    const body = await readBlockAsMarkdown(blockId, {
      redact: redactHumanAudience,
      executor: tx,
    });
    const preamble = await deliverWithRead({
      conversationId,
      pageId,
      readRootId: blockId,
      body,
      executor: tx,
    });
    return { preamble, body };
  });
}

/** The write rule's verdict: `null` when admitted, the refusal otherwise. */
async function writeVerdict(
  conversationId: string,
  pageId: string,
): Promise<HttpError | null> {
  // The refusal is caught INSIDE the transaction: thrown out of it, the
  // transaction would roll back the delivery the refusal just recorded, which
  // the tool (running on the process db, outside any transaction) keeps.
  return t.db.transaction(async (tx) => {
    try {
      await assertInstructionsReceived({
        tool: "edit_page",
        conversationId,
        pageId,
        executor: tx,
      });
      return null;
    } catch (err) {
      if (err instanceof HttpError) return err;
      throw err;
    }
  });
}

describe("read_page's preamble", () => {
  test("a read deep in the tree opens with every covering instructions block, once", async () => {
    const first = await read("conv", "TRACK", "TRACK");
    expect(first.preamble.startsWith("<received-instructions>")).toBe(true);
    expect(first.preamble).toContain('id="IR" form="card"');
    expect(first.preamble).toContain("root rule");
    expect(first.preamble).toContain('id="TI" form="page"');
    expect(first.preamble).toContain("track rules");
    expect(first.preamble).toContain('covers-page-title="Current tracks"');
    // Root-first: the general before the particular.
    expect(first.preamble.indexOf('id="IR"')).toBeLessThan(
      first.preamble.indexOf('id="TI"'),
    );
    expect(first.body).not.toContain("received-instructions");

    expect((await read("conv", "TRACK", "TRACK")).preamble).toBe("");
    // Another conversation has received nothing.
    expect((await read("other", "TRACK", "TRACK")).preamble).not.toBe("");
  });

  test("a card the page already shows in full is not repeated, and still counts as received", async () => {
    const { preamble, body } = await read("conv", "ROOT", "ROOT");
    expect(body).toContain('<instructions id="IR">');
    expect(preamble).toBe("");
    expect(await writeVerdict("conv", "ROOT")).toBeNull();
  });

  test("a read inside the card shows only part of it — the preamble still carries it", async () => {
    const { preamble } = await read("conv", "IR-1", "ROOT");
    expect(preamble).toContain('id="IR"');
  });

  test("reading an instructions page delivers it; the preamble carries only the rest", async () => {
    const { preamble, body } = await read("conv", "TI", "TI");
    expect(body).toContain("track rules");
    expect(preamble).toContain('id="IR"');
    expect(preamble).not.toContain('id="TI"');
    expect(await writeVerdict("conv", "TRACK")).toBeNull();
  });
});

describe("the write rule", () => {
  test("refused with the instructions in full, then admitted on retry", async () => {
    const refusal = await writeVerdict("conv", "TRACK");
    expect(refusal?.status).toBe(409);
    expect(refusal?.message).toContain("nothing was written");
    expect(refusal?.message).toContain("root rule");
    expect(refusal?.message).toContain("track rules");
    expect(await writeVerdict("conv", "TRACK")).toBeNull();
  });

  test("a page with no instructions in scope is never refused", async () => {
    await t.db.execute(
      sql`DELETE FROM page_blocks WHERE id IN ('IR-1', 'IR', 'TI-1', 'TI')`,
    );
    expect(await writeVerdict("conv", "TRACK")).toBeNull();
  });

  test("an edit to received instructions refuses again, carrying only the edited one", async () => {
    await read("conv", "TRACK", "TRACK");
    expect(await writeVerdict("conv", "TRACK")).toBeNull();

    await setData("IR-1", text("root rule, revised"));
    const refusal = await writeVerdict("conv", "TRACK");
    expect(refusal?.status).toBe(409);
    expect(refusal?.message).toContain("root rule, revised");
    expect(refusal?.message).not.toContain("track rules");
    expect(await writeVerdict("conv", "TRACK")).toBeNull();
  });
});

describe("the connect-time section", () => {
  test("with no global instructions, only the fixed paragraph", async () => {
    const section = await t.db.transaction((tx) =>
      renderGlobalSection("conv", tx),
    );
    expect(section).toContain("## Page instructions");
    expect(section).not.toContain("global-instructions");
    expect(section).not.toContain("<instructions-page");
  });

  test("global cards in full and received; global pages as pointers, not received", async () => {
    await setData("IR", { global: true });
    await setData("TI", {
      title: "Track instructions",
      icon: null,
      instructions: true,
      global: true,
    });
    const section = await t.db.transaction((tx) =>
      renderGlobalSection("conv", tx),
    );
    expect(section).toContain("<global-instructions>");
    expect(section).toContain("root rule");
    expect(section).toContain(
      '<instructions-page id="TI" title="Track instructions"/>',
    );
    expect(section).toContain('before working under "Current tracks"');
    expect(section).not.toContain("track rules");

    expect(await writeVerdict("conv", "ROOT")).toBeNull();
    const refusal = await writeVerdict("conv", "TRACK");
    expect(refusal?.message).toContain("track rules");
    expect(refusal?.message).not.toContain("root rule");
  });
});

describe("after a compaction", () => {
  const restore = (conversationId: string) =>
    t.db.transaction((tx) => restoreAfterCompaction(conversationId, tx));

  test("nothing received, nothing restored", async () => {
    expect(await restore("conv")).toBe("");
  });

  test("hands back everything received, at its current version, and it still counts", async () => {
    await read("conv", "TRACK", "TRACK");
    await setData("IR-1", text("root rule, revised"));

    const restored = await restore("conv");
    expect(restored.startsWith("<received-instructions>")).toBe(true);
    expect(restored).toContain("compacted");
    expect(restored).toContain('id="IR" form="card"');
    expect(restored).toContain("root rule, revised");
    expect(restored).toContain('id="TI" form="page"');
    expect(restored).toContain("track rules");
    // Where an instructions page applied is only known to the read that reached it.
    expect(restored).not.toContain("covers-page-id");

    // Received again: no refusal, no repeat on the next read.
    expect(await writeVerdict("conv", "TRACK")).toBeNull();
    expect((await read("conv", "TRACK", "TRACK")).preamble).toBe("");
    // Another conversation is untouched.
    expect(await restore("other")).toBe("");
  });

  test("a block no longer instructions since it was received is forgotten, not restored", async () => {
    await read("conv", "TRACK", "TRACK");
    await setData("TI", { title: "Track instructions", icon: null });
    const restored = await restore("conv");
    expect(restored).toContain('id="IR"');
    expect(restored).not.toContain('id="TI"');
  });

  test("global cards ride the system prompt, which survives: not repeated", async () => {
    await setData("IR", { global: true });
    await t.db.transaction((tx) => renderGlobalSection("conv", tx));
    await read("conv", "TRACK", "TRACK");

    const restored = await restore("conv");
    expect(restored).not.toContain('id="IR"');
    expect(restored).toContain('id="TI"');
    expect(await writeVerdict("conv", "ROOT")).toBeNull();
  });
});
