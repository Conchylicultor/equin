/**
 * Real-DB suite for the two page-row writes that are not the header's own
 * `PATCH` — `setPageKindOf` (the kind control) and `renamePage` (an agent's
 * rename) — driven against a throwaway Postgres (db-test-fixture) with the REAL
 * migration chain, as `handle-patch-blocks.test.ts` is.
 *
 * What it pins (research/2026-09-15-page-agent-page-follow-ups.md §1, §3):
 *  - a flip writes the author and nothing else, both ways, and announces once;
 *  - setting the author a page already has writes nothing and announces nothing;
 *  - a rename keeps every other key, the author included;
 *  - `requireAuthor` refuses (409) a page that is not that party's, and writes
 *    nothing;
 *  - `setPageIcon` keeps every other key, and `onlyIfUnset` never overwrites
 *    an icon the page already has;
 *  - neither op reaches a non-page row, or a trashed one.
 *
 * Run: `./equin test plugins/page/plugins/editor`
 * (requires the running embedded cluster — `./equin build` first).
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { defineBlock, textBlockSchema } from "../../core";
import { pageBlockHandle } from "../../core/schemas";
import { _blocks } from "./tables";
import { Editor } from "./block-registry";
import { parseBlockData } from "./parse-block-data";
import { deleteBlocksSubtree } from "./trash-blocks";
import { setPageKindOf } from "./handle-set-page-kind";
import { renamePage } from "./rename-page";
import { setPageIcon } from "./set-page-icon";
import { EmojiSchema } from "@plugins/ui/plugins/icons/plugins/emoji/core";

// Stand-in for `page/text` (the concrete block plugin imports this one, so
// importing it back would be a cycle).
const textBlockStub = defineBlock({
  type: "text",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
});

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "page_row_write_test" });
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

beforeEach(async () => {
  // Re-installed per test: the registry is process-global, and another suite
  // in the same run installs its own.
  collectContributions([
    {
      id: "page-row-write-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(textBlockStub),
      ],
    },
  ]);
  await t.db.execute(sql`DELETE FROM page_blocks`);
  await t.db.execute(sql`DELETE FROM trash_entries`);
  await t.db.execute(sql`DELETE FROM event_emissions`);
});

// ── Helpers ────────────────────────────────────────────────────────────────

const PAGE = { kind: "page" } as const;
const AGENT_PAGE = { kind: "agent-page" } as const;

/** A cover, so "every other key is carried" is checked on a nested value too. */
const COVER = { type: "gradient", preset: "sunset" } as const;

/**
 * P (a top-level human page) ▸ [SUB (a human's sub-page, with an icon and a
 * cover), c1 "hello"], and AGENT (an agent-authored sub-page of P).
 */
async function seed(): Promise<void> {
  await t.db.insert(_blocks).values([
    {
      id: "P",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
      data: parseBlockData("page", { title: "P", icon: null }),
    },
    {
      id: "SUB",
      parentId: "P",
      pageId: "P",
      type: "page",
      rank: "a0",
      data: parseBlockData("page", {
        title: "Notes",
        icon: "🚀",
        cover: COVER,
      }),
    },
    {
      id: "AGENT",
      parentId: "P",
      pageId: "P",
      type: "page",
      rank: "a1",
      data: parseBlockData("page", {
        title: "Findings",
        icon: null,
        author: "agent",
      }),
    },
    {
      id: "c1",
      parentId: "P",
      pageId: "P",
      type: "text",
      rank: "a2",
      data: parseBlockData("text", { text: "hello" }),
    },
  ]);
}

async function row(id: string) {
  const [r] = await t.db.select().from(_blocks).where(eq(_blocks.id, id));
  if (!r) throw new Error(`no row ${id}`);
  return r;
}

/**
 * A row's stored `data`, widened to `unknown` so a test compares it against a
 * plain literal — the `BlockData` brand is for writers, and a reader needs none.
 */
async function storedData(id: string): Promise<unknown> {
  return (await row(id)).data;
}

/** The `page.blocksChanged` announcements since the last reset, by page id. */
async function announced(): Promise<string[]> {
  const res = await t.db.execute<{ page_id: string }>(
    sql`SELECT payload->>'pageId' AS page_id FROM event_emissions
        WHERE event_name = 'page.blocksChanged'`,
  );
  return res.rows.map((r) => r.page_id).sort();
}

/** Await a write that must be refused with `status`, returning its message. */
async function refusedWith(
  write: Promise<unknown>,
  status: number,
): Promise<string> {
  try {
    await write;
  } catch (err) {
    if (!(err instanceof HttpError)) throw err;
    expect(err.status).toBe(status);
    return err.message;
  }
  throw new Error(`expected an HTTP ${status}`);
}

// ── setPageKindOf ──────────────────────────────────────────────────────────

describe("setPageKindOf — the kind control", () => {
  test("human → agent writes the marker, carries every other key, and announces once", async () => {
    await seed();
    const before = await row("SUB");

    const block = await setPageKindOf("SUB", AGENT_PAGE, t.db);

    const expected = {
      title: "Notes",
      icon: "🚀",
      cover: COVER,
      author: "agent",
    };
    expect(await storedData("SUB")).toEqual(expected);
    expect(block.data).toEqual(expected);
    expect(block.id).toBe("SUB");
    // Nothing else about the row moved.
    const after = await row("SUB");
    expect(after.parentId).toBe(before.parentId);
    expect(after.rank).toBe(before.rank);
    expect(after.updatedAt.getTime()).toBeGreaterThanOrEqual(
      before.updatedAt.getTime(),
    );
    // One announcement: the page's own id, and the page it sits in.
    expect(await announced()).toEqual(["P", "SUB"]);
  });

  test("agent → human removes the key, and announces once", async () => {
    await seed();

    await setPageKindOf("AGENT", PAGE, t.db);

    const data = await storedData("AGENT");
    expect(data).toEqual({ title: "Findings", icon: null });
    expect(Object.keys(data as object)).not.toContain("author");
    expect(await announced()).toEqual(["AGENT", "P"]);
  });

  test("setting the author a page already has is a no-op: no write, no event", async () => {
    await seed();
    const agentBefore = await row("AGENT");
    const humanBefore = await row("SUB");

    const agent = await setPageKindOf("AGENT", AGENT_PAGE, t.db);
    const human = await setPageKindOf("SUB", PAGE, t.db);

    // Byte-for-byte the same rows, `updated_at` included.
    expect(await row("AGENT")).toEqual(agentBefore);
    expect(await row("SUB")).toEqual(humanBefore);
    expect(agent.data).toEqual(agentBefore.data);
    expect(human.data).toEqual(humanBefore.data);
    expect(await announced()).toEqual([]);
  });

  test("a flip there and back is two writes, and lands where it started", async () => {
    await seed();
    await setPageKindOf("SUB", AGENT_PAGE, t.db);
    await setPageKindOf("SUB", PAGE, t.db);
    expect(await storedData("SUB")).toEqual({
      title: "Notes",
      icon: "🚀",
      cover: COVER,
    });
  });

  test("a top-level page can be flipped too — its only announcement is its own id", async () => {
    await seed();
    await setPageKindOf("P", AGENT_PAGE, t.db);
    expect(await storedData("P")).toEqual({
      title: "P",
      icon: null,
      author: "agent",
    });
    // A root page sits in the workspace root, which has no content list.
    expect(await announced()).toEqual(["P"]);
  });

  test("a non-page row is a 400; an unknown or trashed one a 404 — and nothing is written", async () => {
    await seed();
    await refusedWith(setPageKindOf("c1", AGENT_PAGE, t.db), 400);
    await refusedWith(setPageKindOf("nope", AGENT_PAGE, t.db), 404);

    await deleteBlocksSubtree(["SUB"], t.db);
    await t.db.execute(sql`DELETE FROM event_emissions`);
    await refusedWith(setPageKindOf("SUB", AGENT_PAGE, t.db), 404);
    expect(await storedData("SUB")).toEqual({
      title: "Notes",
      icon: "🚀",
      cover: COVER,
    });
    expect(await announced()).toEqual([]);
  });
});

describe("setPageKindOf — instructions pages", () => {
  test("page → instructions (global) writes both keys and keeps the rest", async () => {
    await seed();
    const block = await setPageKindOf(
      "SUB",
      { kind: "instructions", global: true },
      t.db,
    );
    const expected = {
      title: "Notes",
      icon: "🚀",
      cover: COVER,
      instructions: true,
      global: true,
    };
    expect(await storedData("SUB")).toEqual(expected);
    expect(block.data).toEqual(expected);
  });

  test("agent page → instructions drops the author: the kinds are exclusive", async () => {
    await seed();
    await setPageKindOf("AGENT", { kind: "instructions", global: false }, t.db);
    expect(await storedData("AGENT")).toEqual({
      title: "Findings",
      icon: null,
      instructions: true,
    });
  });

  test("toggling global is a write; the same kind again is a no-op", async () => {
    await seed();
    await setPageKindOf("SUB", { kind: "instructions", global: false }, t.db);
    await setPageKindOf("SUB", { kind: "instructions", global: true }, t.db);
    expect(await storedData("SUB")).toMatchObject({ global: true });
    await t.db.execute(sql`DELETE FROM event_emissions`);
    const before = await row("SUB");
    await setPageKindOf("SUB", { kind: "instructions", global: true }, t.db);
    expect(await row("SUB")).toEqual(before);
    expect(await announced()).toEqual([]);
  });

  test("instructions → page removes every kind key", async () => {
    await seed();
    await setPageKindOf("SUB", { kind: "instructions", global: true }, t.db);
    await setPageKindOf("SUB", PAGE, t.db);
    expect(await storedData("SUB")).toEqual({
      title: "Notes",
      icon: "🚀",
      cover: COVER,
    });
  });
});

// ── renamePage ─────────────────────────────────────────────────────────────

describe("renamePage — an agent's rename", () => {
  test("renames, keeping every other key — the author included", async () => {
    await seed();

    const block = await renamePage("AGENT", "Final findings", {}, t.db);

    const expected = { title: "Final findings", icon: null, author: "agent" };
    expect(await storedData("AGENT")).toEqual(expected);
    expect(block.data).toEqual(expected);
    expect(await announced()).toEqual(["AGENT", "P"]);
  });

  test("a human's page keeps its icon and cover through a rename", async () => {
    await seed();
    await renamePage("SUB", "Renamed", {}, t.db);
    expect(await storedData("SUB")).toEqual({
      title: "Renamed",
      icon: "🚀",
      cover: COVER,
    });
  });

  test("requireAuthor: 'agent' renames an agent page", async () => {
    await seed();
    await renamePage(
      "AGENT",
      "Final findings",
      { requireAuthor: "agent" },
      t.db,
    );
    expect(await storedData("AGENT")).toEqual({
      title: "Final findings",
      icon: null,
      author: "agent",
    });
  });

  test("requireAuthor: 'agent' refuses a human's page with a 409, and writes nothing", async () => {
    await seed();
    const before = await row("SUB");

    const message = await refusedWith(
      renamePage("SUB", "Hijacked", { requireAuthor: "agent" }, t.db),
      409,
    );

    expect(message).toMatch(/human's page/);
    expect(await row("SUB")).toEqual(before);
    expect(await announced()).toEqual([]);
  });

  test("requireAuthor sees a flip that landed first — the race it exists for", async () => {
    await seed();
    // The tool decided "agent page, so this is a rename"; the human flips it
    // before the rename's write.
    await setPageKindOf("AGENT", PAGE, t.db);
    await refusedWith(
      renamePage("AGENT", "Too late", { requireAuthor: "agent" }, t.db),
      409,
    );
    expect(await storedData("AGENT")).toEqual({
      title: "Findings",
      icon: null,
    });
  });

  test("an unchanged title writes nothing and announces nothing", async () => {
    await seed();
    const before = await row("AGENT");
    const block = await renamePage("AGENT", "Findings", {}, t.db);
    expect(await row("AGENT")).toEqual(before);
    expect(block.data).toEqual(before.data);
    expect(await announced()).toEqual([]);
  });

  test("a non-page row is a 400; an unknown one a 404", async () => {
    await seed();
    await refusedWith(renamePage("c1", "x", {}, t.db), 400);
    await refusedWith(renamePage("nope", "x", {}, t.db), 404);
  });
});

// ── setPageIcon ────────────────────────────────────────────────────────────

describe("setPageIcon — the server-side icon write", () => {
  const TEST_TUBE = EmojiSchema.parse("🧪");

  test("sets the icon, keeping every other key, and announces once", async () => {
    await seed();
    const block = await setPageIcon("SUB", TEST_TUBE, {}, t.db);
    const expected = { title: "Notes", icon: "🧪", cover: COVER };
    expect(await storedData("SUB")).toEqual(expected);
    expect(block.data).toEqual(expected);
    expect(await announced()).toEqual(["P", "SUB"]);
  });

  test("null clears it", async () => {
    await seed();
    await setPageIcon("SUB", null, {}, t.db);
    expect(await storedData("SUB")).toEqual({
      title: "Notes",
      icon: null,
      cover: COVER,
    });
  });

  test("onlyIfUnset writes an unset icon, and never overwrites a set one", async () => {
    await seed();
    await setPageIcon("AGENT", TEST_TUBE, { onlyIfUnset: true }, t.db);
    expect(await storedData("AGENT")).toMatchObject({ icon: "🧪" });

    await t.db.execute(sql`DELETE FROM event_emissions`);
    const before = await row("SUB");
    await setPageIcon("SUB", TEST_TUBE, { onlyIfUnset: true }, t.db);
    expect(await row("SUB")).toEqual(before);
    expect(await announced()).toEqual([]);
  });

  test("the icon a page already has writes nothing and announces nothing", async () => {
    await seed();
    await setPageIcon("SUB", TEST_TUBE, {}, t.db);
    await t.db.execute(sql`DELETE FROM event_emissions`);
    const before = await row("SUB");
    await setPageIcon("SUB", TEST_TUBE, {}, t.db);
    expect(await row("SUB")).toEqual(before);
    expect(await announced()).toEqual([]);
  });

  test("a non-page row is a 400; an unknown one a 404", async () => {
    await seed();
    await refusedWith(setPageIcon("c1", TEST_TUBE, {}, t.db), 400);
    await refusedWith(setPageIcon("nope", TEST_TUBE, {}, t.db), 404);
  });
});
