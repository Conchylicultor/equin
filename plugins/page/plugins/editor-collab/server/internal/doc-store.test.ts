/**
 * Real-DB invariant suite for the per-block content-CRDT store (Stage 1 of
 * research/2026-07-07-page-per-block-crdt-plan-b.md). Headless — no browser,
 * no editor: builds Lexical-shaped Yjs docs via the Stage 0 seam
 * (`runsToXmlText` with NO extensions), drives the db-parametrized store
 * functions against a throwaway Postgres (db-test-fixture), and reads state
 * back through `xmlTextToRuns` to assert content.
 *
 * Run: `bun test plugins/page/plugins/editor-collab/server/internal`
 * (requires the running embedded cluster — `./singularity build` first).
 */

import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import { eq, sql } from "drizzle-orm";
import * as Y from "yjs";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { yDocContent } from "@plugins/primitives/plugins/collab-doc/core";
import {
  plainOf,
  runsOf,
  runsToXmlText,
  xmlTextToRuns,
} from "@plugins/page/plugins/editor/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/infra/plugins/query-resource/server/testing";
import { compileCollection } from "@plugins/network/plugins/live/server";
import { bytesToBase64 } from "@plugins/fields/plugins/bytes/plugins/storage/server";
import { blockDocs } from "../../core";
import type { BlockDocRow } from "../../core/internal/resources";
import { _pageBlockDocs } from "./tables";
import { initBlockDoc, loadBlockDocs, mergeBlockDocUpdate } from "./doc-store";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "ec_test" });
  // The REAL schema, via the real migration chain (db-parametrized runner) — no
  // hand-mirrored DDL to drift, and the page_blocks FK + ON DELETE CASCADE are
  // exactly what production applies.
  await runMigrations(t.db);
});

afterAll(async () => {
  await t.drop();
});

let nextBlock = 0;
async function createBlock(): Promise<string> {
  const id = `block-${++nextBlock}`;
  // Unique valid rank per root block: the live-rank partial unique index
  // (`page_blocks_root_rank_live_uq`) enforces distinct ranks among live
  // parent-less rows, so a constant 'a0' would collide from the second block
  // on. 'b' + two base-36 digits is a plain 3-char integer key — always a
  // valid fractional-indexing rank, unique up to 1296 blocks.
  const rank = `b${nextBlock.toString(36).padStart(2, "0")}`;
  await t.db.execute(
    sql`INSERT INTO page_blocks (id, type, rank) VALUES (${id}, 'text', ${rank})`,
  );
  return id;
}

/** A fresh content doc seeded from plain text (no extensions — server-safe). */
function docOf(text: string): Y.Doc {
  const doc = runsToXmlText(runsOf(text)).doc;
  if (!doc) throw new Error("runsToXmlText returned a detached XmlText");
  return doc;
}

/** Append plain text at the end of the doc's single paragraph, in place. */
function appendText(doc: Y.Doc, text: string): void {
  const root = yDocContent(doc);
  const first = (root.toDelta() as Array<{ insert: unknown }>)[0]?.insert;
  if (!(first instanceof Y.XmlText)) {
    throw new Error("expected a paragraph XmlText at the content root");
  }
  first.insert(first.length, text);
}

/** Decode stored state bytes → plain text via the Stage 0 runs bridge. */
function textOfState(state: Uint8Array): string {
  const doc = new Y.Doc();
  Y.applyUpdate(doc, state);
  return plainOf(xmlTextToRuns(yDocContent(doc)));
}

async function storedState(blockId: string): Promise<Uint8Array> {
  const [row] = await t.db
    .select({ state: _pageBlockDocs.state })
    .from(_pageBlockDocs)
    .where(eq(_pageBlockDocs.blockId, blockId));
  if (!row) throw new Error(`no page_block_docs row for ${blockId}`);
  return row.state;
}

describe("initBlockDoc (first-writer-wins seed)", () => {
  test("first init stores the proposed state and returns it", async () => {
    const blockId = await createBlock();
    const proposed = Y.encodeStateAsUpdate(docOf("hello"));

    const authoritative = await initBlockDoc(t.db, blockId, proposed);

    expect(textOfState(authoritative)).toBe("hello");
    expect(textOfState(await storedState(blockId))).toBe("hello");
  });

  test("init for a nonexistent block → 404 (FK precondition), not a raw 23503 500", async () => {
    const proposed = Y.encodeStateAsUpdate(docOf("premature"));

    let caught: unknown;
    try {
      await initBlockDoc(t.db, "no-such-block", proposed);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(404);

    // And nothing was written.
    expect((await loadBlockDocs(t.db, ["no-such-block"])).size).toBe(0);
  });

  test("second init with DIFFERENT bytes is a no-op and returns the winner's state", async () => {
    const blockId = await createBlock();
    const winner = Y.encodeStateAsUpdate(docOf("winner"));
    const loser = Y.encodeStateAsUpdate(docOf("loser"));

    await initBlockDoc(t.db, blockId, winner);
    const authoritative = await initBlockDoc(t.db, blockId, loser);

    // The loser gets back the winner's state — no overwrite, no duplication.
    expect(textOfState(authoritative)).toBe("winner");
    expect(textOfState(await storedState(blockId))).toBe("winner");
  });
});

describe("mergeBlockDocUpdate", () => {
  test("merges an incremental update; stored runs reflect the merged text", async () => {
    const blockId = await createBlock();
    const origin = docOf("hello");
    const originState = Y.encodeStateAsUpdate(origin);
    await initBlockDoc(t.db, blockId, originState);

    // A client replica edits: "hello" → "hello world"; ship only the delta.
    const replica = new Y.Doc();
    Y.applyUpdate(replica, originState);
    appendText(replica, " world");
    const incremental = Y.encodeStateAsUpdate(
      replica,
      Y.encodeStateVector(origin),
    );

    await mergeBlockDocUpdate(t.db, blockId, incremental);

    expect(textOfState(await storedState(blockId))).toBe("hello world");
  });

  test("replaying the same update is idempotent (CRDT merge)", async () => {
    const blockId = await createBlock();
    const origin = docOf("abc");
    const originState = Y.encodeStateAsUpdate(origin);
    await initBlockDoc(t.db, blockId, originState);

    const replica = new Y.Doc();
    Y.applyUpdate(replica, originState);
    appendText(replica, "def");
    const incremental = Y.encodeStateAsUpdate(
      replica,
      Y.encodeStateVector(origin),
    );

    await mergeBlockDocUpdate(t.db, blockId, incremental);
    await mergeBlockDocUpdate(t.db, blockId, incremental);

    expect(textOfState(await storedState(blockId))).toBe("abcdef");
  });

  test("uninitialized doc → 409 (never auto-seeds)", async () => {
    const blockId = await createBlock();
    const update = Y.encodeStateAsUpdate(docOf("orphan"));

    let caught: unknown;
    try {
      await mergeBlockDocUpdate(t.db, blockId, update);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(HttpError);
    expect((caught as HttpError).status).toBe(409);

    // And nothing was written.
    expect((await loadBlockDocs(t.db, [blockId])).size).toBe(0);
  });
});

describe("blockDocs :rows (the served lookup-only collection)", () => {
  /** The `:rows` point loader `serveCollection` registers, over the test DB. */
  const readRows = (ids: string[]): Promise<BlockDocRow[]> => {
    const specs = compileCollection(blockDocs, {
      from: _pageBlockDocs,
      db: t.db as unknown as QueryDb,
    });
    const { loader } = compileWindowQuery(
      blockDocs.rows,
      specs.rows,
    ).serverOpts;
    return Promise.resolve(loader(blockDocs.rows.point.encode(ids))) as Promise<
      BlockDocRow[]
    >;
  };

  test("serves the bytea state as unfolded base64, byte-identical to bytesToBase64", async () => {
    const blockId = await createBlock();
    // Well past 76 bytes — where SQL's `encode(…, 'base64')` would fold lines.
    const state = Y.encodeStateAsUpdate(docOf("x".repeat(400)));
    expect(state.length).toBeGreaterThan(76 * 3);
    await initBlockDoc(t.db, blockId, state);

    const rows = await readRows([blockId]);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.blockId).toBe(blockId);
    expect(rows[0]!.updatedAt).toBeInstanceOf(Date);
    expect(rows[0]!.state).toBe(bytesToBase64(await storedState(blockId)));
    expect(rows[0]!.state).not.toContain("\n");

    // The base64 round-trips back to the exact stored doc.
    const decoded = new Uint8Array(Buffer.from(rows[0]!.state, "base64"));
    expect(
      Buffer.from(decoded).equals(Buffer.from(await storedState(blockId))),
    ).toBe(true);
    expect(textOfState(decoded)).toBe("x".repeat(400));
  });

  test("an uninitialized block is absent — the reader's found: false", async () => {
    const blockId = await createBlock();
    expect(await readRows([blockId])).toEqual([]);
  });
});

describe("loadBlockDocs (batched raw-bytes read)", () => {
  test("returns each stored state byte-exact, keyed by block id; a doc-less block is absent", async () => {
    const a = await createBlock();
    const b = await createBlock();
    const bare = await createBlock();
    await initBlockDoc(t.db, a, Y.encodeStateAsUpdate(docOf("alpha")));
    await initBlockDoc(t.db, b, Y.encodeStateAsUpdate(docOf("bravo")));

    const states = await loadBlockDocs(t.db, [a, b, bare]);

    expect([...states.keys()].sort()).toEqual([a, b].sort());
    expect(states.get(a)).toEqual(await storedState(a));
    expect(textOfState(states.get(b)!)).toBe("bravo");
    expect(states.has(bare)).toBe(false);
  });

  test("no ids → an empty map", async () => {
    expect((await loadBlockDocs(t.db, [])).size).toBe(0);
  });
});

describe("FK lifecycle", () => {
  test("deleting the block cascades its doc row away", async () => {
    const blockId = await createBlock();
    await initBlockDoc(t.db, blockId, Y.encodeStateAsUpdate(docOf("doomed")));
    expect((await loadBlockDocs(t.db, [blockId])).size).toBe(1);

    await t.db.execute(sql`DELETE FROM page_blocks WHERE id = ${blockId}`);
    expect((await loadBlockDocs(t.db, [blockId])).size).toBe(0);
  });
});
