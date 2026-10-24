/**
 * Writer oracle for `page_blocks.doc_rank` — invariant I-DR: within every
 * sidebar group (live page rows sharing a `page_id`), ordering by `doc_rank`
 * equals document order (`docOrderRows` + `compareDocOrder`).
 *
 * Drives the REAL writers against a throwaway Postgres (db-test-fixture) with
 * the real migration chain: random sequences of `applyPageBlockOp` (insert,
 * move, indent, outdent, bulkMove, paste — sub-page copies included — splice,
 * unwrap, delete), field-scoped patches, trash restores, cross-page moves and
 * turn-into-page. After EVERY step the invariant is checked against the global
 * document order, and the boot reconcile is a no-op. The marks live in the
 * lowest-level mutators, so a writer that bypassed them would surface here as a
 * group out of order.
 *
 * Plus the pinned cases: the depth-2 to-do-under-to-do drag (a sub-page moved
 * by a write that never names its row), a data-only patch issuing NO reconcile
 * query, and the boot reconcile's backfill / drift classification.
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
import { z } from "zod";
import { asc, eq, sql } from "drizzle-orm";
import { Client, Pool, type QueryConfig } from "pg";
import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import { HttpError } from "@plugins/infra/plugins/endpoints/core";
import { TrashEntrySchema } from "@plugins/infra/plugins/trash/core";
import { _trashEntries } from "@plugins/infra/plugins/trash/server";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import { rankAdjacentTo } from "@plugins/primitives/plugins/rank/server";
import { defineBlock, textBlockSchema, type IdentifiedBlock } from "../../core";
import {
  pageBlockHandle,
  PAGE_BLOCK_TYPE,
  withPageKind,
} from "../../core/schemas";
import { _blocks } from "./tables";
import { Editor } from "./block-registry";
import { parseBlockData, rewriteBlockData } from "./parse-block-data";
import { withPageForest } from "./page-forest";
import { insertBlocks, updateBlockFields } from "./forest-writer";
import { recomputePageIdSubtree } from "./page-id";
import { loadLiveSiblings } from "./forest";
import { applyPageBlockOp } from "./handle-apply-block-op";
import { applyPageBlockPatch } from "./handle-patch-blocks";
import { untrashBlocks } from "./trash-blocks";
import {
  compareDocOrder,
  docOrderRows,
  type DocOrderRow,
} from "./page-doc-order";
import { planPartitionDocRanks } from "./doc-rank";
import { reconcileDocRanksAtBoot } from "./doc-rank-boot";
import { loadPages } from "./resources";
import { pageContentEditedAt } from "./rollup-spec";

// Stand-ins for the concrete block types (each imports this plugin, so
// importing them back would be a cycle). `para` is the default text type, so
// `splice` has a plain paragraph to merge into; `todo` is a text-bearing
// container like the real `to-do`; `callout` is a void container anchor, which
// `unwrap` dissolves.
const paraStub = defineBlock({
  type: "para",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
  defaultText: true,
});
const todoStub = defineBlock({
  type: "todo",
  schema: textBlockSchema({ checked: z.boolean().optional() }),
  empty: () => ({ text: [] }),
});
const calloutStub = defineBlock({
  type: "callout",
  schema: z.object({}),
  empty: () => ({}),
  anchor: true,
});

const TEXT_TYPES = ["para", "todo"] as const;

let t: TestDb;

/** Every SQL text the counting pool ran, in order. */
const statements: string[] = [];

/**
 * A pg client that records every statement it runs — the only way to see the
 * queries inside a drizzle transaction, which runs on a checked-out client
 * rather than through `pool.query`.
 */
class CountingClient extends Client {
  override query(...args: unknown[]): never {
    const first = args[0];
    statements.push(
      typeof first === "string" ? first : (first as QueryConfig).text,
    );
    return (super.query as (...a: unknown[]) => never)(...args);
  }
}
let countingPool: Pool;
let countingDb: NodePgDatabase;

beforeAll(async () => {
  t = await createTestDb({ prefix: "page_doc_rank_test" });
  await runMigrations(t.db);
  // `loadPages` reads each page's `editedAt` off the content rollup, which a
  // backend installs at boot (`rebuildDerivedTables`) — the same path.
  await installRollups(t.db, [pageContentEditedAt]);
  countingPool = new Pool({
    connectionString: t.connectionString,
    max: 1,
    Client: CountingClient,
  });
  countingDb = drizzle(countingPool);
  collectContributions([
    {
      id: "page-doc-rank-test",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(paraStub),
        Editor.BlockData(todoStub),
        Editor.BlockData(calloutStub),
      ],
    },
  ]);
});

afterAll(async () => {
  await countingPool.end();
  await t.drop();
});

beforeEach(async () => {
  await t.db.execute(sql`DELETE FROM page_blocks`);
  await t.db.execute(sql`DELETE FROM trash_entries`);
  await t.db.execute(sql`DELETE FROM event_emissions`);
});

// ── Helpers ────────────────────────────────────────────────────────────────

let seq = 0;
function freshId(prefix: string): string {
  seq += 1;
  return `${prefix}${seq}`;
}

function pagePayload(title: string): unknown {
  return { title, icon: null };
}

function payloadFor(type: string, text: string): unknown {
  if (type === PAGE_BLOCK_TYPE) return pagePayload(text);
  if (type === "callout") return {};
  return { text: [{ text }] };
}

/**
 * Insert one row through the REAL mutator, under the lock of the group it
 * lands in — so the reconcile places it, as for any production insert.
 */
async function seed(args: {
  id: string;
  parentId: string | null;
  pageId: string | null;
  type: string;
  rank: string;
}): Promise<void> {
  await withPageForest(
    args.pageId,
    async (ctx) => {
      await insertBlocks(ctx.tx, [
        {
          id: args.id,
          parentId: args.parentId,
          pageId: args.pageId,
          type: args.type,
          rank: args.rank,
          data: parseBlockData(args.type, payloadFor(args.type, args.id)),
        },
      ]);
    },
    t.db,
  );
}

/** Assert invariant I-DR over every group, against the GLOBAL doc order. */
async function expectInvariant(context: string): Promise<void> {
  const rows = await docOrderRows(t.db);
  const groups = new Map<string | null, DocOrderRow[]>();
  for (const row of rows) {
    const g = groups.get(row.pageId) ?? [];
    g.push(row);
    groups.set(row.pageId, g);
  }
  for (const [pageId, group] of groups) {
    group.sort(compareDocOrder);
    for (const row of group) {
      if (row.docRank === null) {
        throw new Error(
          `${context}: page ${row.id} in ${pageId} has no doc_rank`,
        );
      }
    }
    for (let i = 1; i < group.length; i++) {
      if (Rank.compare(group[i - 1]!.docRank!, group[i]!.docRank!) !== -1) {
        throw new Error(
          `${context}: group ${pageId ?? "root"} out of document order at ${group[i - 1]!.id} → ${group[i]!.id}`,
        );
      }
    }
  }
  // The boot reconcile would find nothing to do.
  expect(planPartitionDocRanks(rows)).toEqual([]);
}

/** The live rows, for the fuzzer to pick targets from. */
async function liveRows(): Promise<
  {
    id: string;
    pageId: string | null;
    parentId: string | null;
    type: string;
    rank: string;
    data: unknown;
  }[]
> {
  return t.db
    .select({
      id: _blocks.id,
      pageId: _blocks.pageId,
      parentId: _blocks.parentId,
      type: _blocks.type,
      rank: _blocks.rank,
      data: _blocks.data,
    })
    .from(_blocks)
    .where(sql`${_blocks.deletedAt} IS NULL`)
    .orderBy(asc(_blocks.id));
}

async function docRankOf(id: string): Promise<string | null> {
  const [row] = await t.db
    .select({ docRank: _blocks.docRank })
    .from(_blocks)
    .where(eq(_blocks.id, id));
  if (!row) throw new Error(`no row ${id}`);
  return row.docRank;
}

/** `handleMoveBlock`'s write, on the fixture: a reparent across pages. */
async function crossPageMove(
  blockId: string,
  parentId: string | null,
  sourcePageId: string | null,
  destPageId: string | null,
): Promise<void> {
  await withPageForest(
    [sourcePageId, destPageId],
    async (ctx) => {
      const { siblings } = await loadLiveSiblings(ctx.tx, parentId);
      const rank = rankAdjacentTo(
        siblings,
        parentId,
        null,
        "after",
        new Set([blockId]),
      );
      await updateBlockFields(ctx.tx, blockId, {
        parentId,
        rank: rank.toJSON(),
      });
      await recomputePageIdSubtree(ctx.tx, blockId);
    },
    t.db,
  );
}

/** `handleTurnIntoPage`'s write, on the fixture. */
async function turnIntoPage(
  blockId: string,
  pageId: string | null,
): Promise<void> {
  await withPageForest(
    [pageId, blockId],
    async (ctx) => {
      const [current] = await ctx.tx
        .select({ type: _blocks.type, data: _blocks.data })
        .from(_blocks)
        .where(eq(_blocks.id, blockId));
      if (!current) throw new Error(`no row ${blockId}`);
      await updateBlockFields(ctx.tx, blockId, {
        type: PAGE_BLOCK_TYPE,
        data: rewriteBlockData({
          type: PAGE_BLOCK_TYPE,
          before: current,
          next: withPageKind(pagePayload(blockId) as Record<string, unknown>, {
            kind: "page",
          }),
        }),
        expanded: false,
      });
      await recomputePageIdSubtree(ctx.tx, blockId);
    },
    t.db,
  );
}

/**
 * Per op kind, how many writes the fuzzer LANDED vs how many the handler
 * refused — so the suite can prove it is not vacuous (every kind landed).
 */
const landed = new Map<string, { ok: number; refused: number }>();
let currentKind = "";
function tally(outcome: "ok" | "refused"): void {
  const entry = landed.get(currentKind) ?? { ok: 0, refused: 0 };
  entry[outcome] += 1;
  landed.set(currentKind, entry);
}

/** A refusal a random op can legitimately meet (a cycle, a 404, a 409). */
async function tolerated(run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
    tally("ok");
  } catch (err) {
    if (err instanceof HttpError) {
      tally("refused");
      return;
    }
    throw err;
  }
}

const OP_KINDS = [
  "insert",
  "insert",
  "move",
  "indent/outdent",
  "bulkMove",
  "paste",
  "splice",
  "unwrap",
  "delete",
  "restore",
  "patch",
  "cross-page move",
  "turn-into-page",
] as const;

/** A tiny seeded PRNG (mulberry32), so a failing sequence reproduces. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let x = a;
    x = Math.imul(x ^ (x >>> 15), x | 1);
    x ^= x + Math.imul(x ^ (x >>> 7), x | 61);
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

// ── The writer oracle ──────────────────────────────────────────────────────

describe("writer oracle: every structural writer keeps I-DR", () => {
  const SEEDS = [1, 2, 3, 4, 5, 6, 7, 8];
  const STEPS = 60;

  // Not vacuous: every op kind really wrote something somewhere in the run.
  afterAll(() => {
    for (const kind of new Set(OP_KINDS)) {
      expect({ kind, ok: (landed.get(kind)?.ok ?? 0) > 0 }).toEqual({
        kind,
        ok: true,
      });
    }
  });

  for (const seedNo of SEEDS) {
    test(`random op sequence, seed ${seedNo}`, async () => {
      const rand = prng(seedNo * 7919);
      const pick = <T>(xs: readonly T[]): T =>
        xs[Math.floor(rand() * xs.length)]!;

      // Two root pages, so a cross-page move has somewhere to go.
      await seed({
        id: "R1",
        parentId: null,
        pageId: null,
        type: "page",
        rank: "a0",
      });
      await seed({
        id: "R2",
        parentId: null,
        pageId: null,
        type: "page",
        rank: "a1",
      });
      await expectInvariant("seed");

      for (let step = 0; step < STEPS; step++) {
        const rows = await liveRows();
        const pages = rows.filter((r) => r.type === PAGE_BLOCK_TYPE);
        const page = pick(pages);
        const inPage = rows.filter((r) => r.pageId === page.id);
        const content = inPage.filter((r) => r.type !== PAGE_BLOCK_TYPE);
        const textRows = inPage.filter((r) =>
          (TEXT_TYPES as readonly string[]).includes(r.type),
        );
        const kind = Math.floor(rand() * OP_KINDS.length);
        currentKind = OP_KINDS[kind]!;
        const label = `seed ${seedNo} step ${step} ${currentKind}`;

        switch (kind) {
          case 0:
          case 1: {
            // Insert a block (a page row a third of the time) under the page
            // or one of its non-page rows.
            const parent =
              rand() < 0.4 || content.length === 0 ? null : pick(content);
            const type =
              rand() < 0.33
                ? PAGE_BLOCK_TYPE
                : pick(["para", "todo", "callout"]);
            const newId = freshId(type === PAGE_BLOCK_TYPE ? "P" : "b");
            await tolerated(() =>
              applyPageBlockOp(
                page.id,
                {
                  kind: "insert",
                  newId,
                  type,
                  data: payloadFor(type, newId),
                  parentId: parent?.id ?? page.id,
                },
                t.db,
              ),
            );
            break;
          }
          case 2: {
            if (inPage.length === 0) break;
            const block = pick(inPage);
            const dest =
              rand() < 0.5 || content.length === 0 ? null : pick(content);
            const siblings = inPage.filter(
              (r) => r.parentId === (dest?.id ?? page.id) && r.id !== block.id,
            );
            await tolerated(() =>
              applyPageBlockOp(
                page.id,
                {
                  kind: "move",
                  blockId: block.id,
                  parentId: dest?.id ?? page.id,
                  targetId: siblings.length > 0 ? pick(siblings).id : null,
                  zone: rand() < 0.5 ? "before" : "after",
                },
                t.db,
              ),
            );
            break;
          }
          case 3: {
            if (inPage.length === 0) break;
            await tolerated(() =>
              applyPageBlockOp(
                page.id,
                {
                  kind: rand() < 0.5 ? "indent" : "outdent",
                  blockIds: [pick(inPage).id],
                },
                t.db,
              ),
            );
            break;
          }
          case 4: {
            if (inPage.length < 2) break;
            const ids = [...new Set([pick(inPage).id, pick(inPage).id])];
            const dest =
              rand() < 0.5 || content.length === 0 ? null : pick(content);
            const siblings = inPage.filter(
              (r) =>
                r.parentId === (dest?.id ?? page.id) && !ids.includes(r.id),
            );
            await tolerated(() =>
              applyPageBlockOp(
                page.id,
                {
                  kind: "bulkMove",
                  ids,
                  parentId: dest?.id ?? page.id,
                  afterId: siblings.length > 0 ? pick(siblings).id : null,
                },
                t.db,
              ),
            );
            break;
          }
          case 5: {
            // Paste a small forest — sometimes holding a COPY of another page,
            // whose content (sub-pages included) lands in new partitions.
            const anchor =
              inPage.length > 0 && rand() < 0.7 ? pick(inPage) : null;
            const forest: IdentifiedBlock[] = [
              {
                id: freshId("b"),
                type: "todo",
                data: payloadFor("todo", "pasted"),
                expanded: true,
                children: [
                  {
                    id: freshId("P"),
                    type: PAGE_BLOCK_TYPE,
                    data: pagePayload("pasted page"),
                    expanded: false,
                    children: [],
                  },
                ],
              },
            ];
            if (rand() < 0.5) {
              // A container holding a sub-page — what `unwrap` dissolves.
              forest.push({
                id: freshId("b"),
                type: "callout",
                data: {},
                expanded: true,
                children: [
                  {
                    id: freshId("b"),
                    type: "para",
                    data: payloadFor("para", "in callout"),
                    expanded: true,
                    children: [],
                  },
                  {
                    id: freshId("P"),
                    type: PAGE_BLOCK_TYPE,
                    data: pagePayload("boxed page"),
                    expanded: false,
                    children: [],
                  },
                ],
              });
            }
            const source = pages.filter((p) => p.id !== page.id);
            if (source.length > 0 && rand() < 0.5) {
              forest.push({
                id: freshId("P"),
                type: PAGE_BLOCK_TYPE,
                data: pagePayload("copy"),
                expanded: false,
                children: [],
                pageSource: { pageId: pick(source).id },
              });
            }
            await tolerated(() =>
              applyPageBlockOp(
                page.id,
                {
                  kind: "paste",
                  forest,
                  afterId: anchor?.id ?? null,
                  parentId: anchor ? undefined : page.id,
                },
                t.db,
              ),
            );
            break;
          }
          case 6: {
            if (textRows.length === 0) break;
            const origin = pick(textRows);
            await tolerated(() =>
              applyPageBlockOp(
                page.id,
                {
                  kind: "splice",
                  blockId: origin.id,
                  position: 0,
                  runs: [{ text: origin.id }],
                  forest: [
                    {
                      id: freshId("b"),
                      type: "para",
                      data: payloadFor("para", "line"),
                      expanded: true,
                      children: [],
                    },
                    {
                      id: freshId("P"),
                      type: PAGE_BLOCK_TYPE,
                      data: pagePayload("spliced page"),
                      expanded: false,
                      children: [],
                    },
                  ],
                  granularity: rand() < 0.5 ? "text" : "blocks",
                  tailId: freshId("b"),
                },
                t.db,
              ),
            );
            break;
          }
          case 7: {
            const callouts = inPage.filter((r) => r.type === "callout");
            if (callouts.length === 0) break;
            await tolerated(() =>
              applyPageBlockOp(
                page.id,
                { kind: "unwrap", blockId: pick(callouts).id },
                t.db,
              ),
            );
            break;
          }
          case 8: {
            if (inPage.length === 0) break;
            await tolerated(() =>
              applyPageBlockOp(
                page.id,
                { kind: "delete", blockIds: [pick(inPage).id] },
                t.db,
              ),
            );
            break;
          }
          case 9: {
            // Restore a trash entry, whole.
            const entries = await t.db.select().from(_trashEntries);
            if (entries.length === 0) break;
            await untrashBlocks(TrashEntrySchema.parse(pick(entries)), t.db);
            tally("ok");
            break;
          }
          case 10: {
            // A field-scoped patch: half data-only, half a re-rank to the end
            // of the row's sibling list.
            if (textRows.length === 0) break;
            const row = pick(textRows);
            if (rand() < 0.5) {
              await tolerated(() =>
                applyPageBlockPatch(
                  page.id,
                  {
                    creates: [],
                    updates: [
                      {
                        id: row.id,
                        changes: { data: payloadFor(row.type, "edited") },
                      },
                    ],
                    deleteIds: [],
                  },
                  t.db,
                ),
              );
            } else {
              const last = rows
                .filter((r) => r.parentId === row.parentId)
                .map((r) => r.rank)
                .sort()
                .at(-1)!;
              await tolerated(() =>
                applyPageBlockPatch(
                  page.id,
                  {
                    creates: [],
                    updates: [
                      {
                        id: row.id,
                        changes: { rank: Rank.between(Rank.from(last), null) },
                      },
                    ],
                    deleteIds: [],
                  },
                  t.db,
                ),
              );
            }
            break;
          }
          case 11: {
            // Cross-page move: a block (sub-pages inside it travel) into
            // another page.
            const others = pages.filter((p) => p.id !== page.id);
            if (inPage.length === 0 || others.length === 0) break;
            const block = pick(inPage);
            const dest = pick(others);
            const destContent = rows.filter(
              (r) => r.pageId === dest.id && r.type !== PAGE_BLOCK_TYPE,
            );
            const parent =
              destContent.length > 0 && rand() < 0.5
                ? pick(destContent).id
                : dest.id;
            // A block moved into its own subtree is refused by the handler's
            // ancestry check; skip that shape rather than corrupt the fixture.
            const subtree = new Set([block.id]);
            for (let grew = true; grew;) {
              grew = false;
              for (const r of rows) {
                if (
                  r.parentId &&
                  subtree.has(r.parentId) &&
                  !subtree.has(r.id)
                ) {
                  subtree.add(r.id);
                  grew = true;
                }
              }
            }
            if (subtree.has(parent)) break;
            await crossPageMove(block.id, parent, page.id, dest.id);
            tally("ok");
            break;
          }
          case 12: {
            // Turn a content block — children and all — into a sub-page.
            const candidates = content.filter((r) => r.type !== "callout");
            if (candidates.length === 0) break;
            await turnIntoPage(pick(candidates).id, page.id);
            tally("ok");
            break;
          }
        }
        await expectInvariant(label);
      }

      // The boot reconcile agrees: nothing to backfill, nothing drifted.
      expect(await reconcileDocRanksAtBoot(t.db)).toEqual({ kind: "clean" });
      // And the sidebar loader reads the maintained column in that order.
      const pagesRead = await loadPages(t.db);
      expect(pagesRead.length).toBe(
        (await liveRows()).filter((r) => r.type === PAGE_BLOCK_TYPE).length,
      );
    });
  }
});

// ── Pinned cases ───────────────────────────────────────────────────────────

describe("a sub-page moved by a write that never names it", () => {
  /**
   *   W
   *   ├── outer (todo)
   *   │   └── inner (todo)
   *   │       └── S (page)        ← depth 2 under content
   *   └── D (page)
   *
   * Dragging `outer` after `D` moves S past D in document order, though no
   * write touches S's row.
   */
  test("dragging the outer to-do re-mints only the nested sub-page", async () => {
    await seed({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seed({
      id: "outer",
      parentId: "W",
      pageId: "W",
      type: "todo",
      rank: "a0",
    });
    await seed({
      id: "inner",
      parentId: "outer",
      pageId: "W",
      type: "todo",
      rank: "a0",
    });
    await seed({
      id: "S",
      parentId: "inner",
      pageId: "W",
      type: "page",
      rank: "a0",
    });
    await seed({
      id: "D",
      parentId: "W",
      pageId: "W",
      type: "page",
      rank: "a1",
    });
    await expectInvariant("seed");
    expect(
      (await loadPages(t.db)).filter((p) => p.pageId === "W").map((p) => p.id),
    ).toEqual(["S", "D"]);
    const before = { S: await docRankOf("S"), D: await docRankOf("D") };

    await applyPageBlockOp(
      "W",
      {
        kind: "move",
        blockId: "outer",
        parentId: "W",
        targetId: "D",
        zone: "after",
      },
      t.db,
    );

    await expectInvariant("after drag");
    expect(
      (await loadPages(t.db)).filter((p) => p.pageId === "W").map((p) => p.id),
    ).toEqual(["D", "S"]);
    // LIS-minimal: one of the pair keeps its key and only the other is
    // re-minted — a two-row swap has two longest runs, and either is one write.
    const changed = [
      (await docRankOf("S")) !== before.S,
      (await docRankOf("D")) !== before.D,
    ].filter(Boolean);
    expect(changed).toHaveLength(1);
  });
});

describe("reconcile cost", () => {
  beforeEach(async () => {
    await seed({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seed({
      id: "p",
      parentId: "W",
      pageId: "W",
      type: "para",
      rank: "a0",
    });
    statements.length = 0;
  });

  /** Statements that are the reconcile's read or write. */
  function reconcileStatements(): string[] {
    return statements.filter(
      (s) =>
        s.includes("WITH RECURSIVE members") ||
        s.includes("doc_rank = v.doc_rank"),
    );
  }

  test("a data-only patch issues no reconcile query", async () => {
    await applyPageBlockPatch(
      "W",
      {
        creates: [],
        updates: [
          { id: "p", changes: { data: payloadFor("para", "typing…") } },
        ],
        deleteIds: [],
      },
      countingDb,
    );
    expect(statements.length).toBeGreaterThan(0);
    expect(reconcileStatements()).toEqual([]);
  });

  test("a structural op in a page with no sub-pages reads once and writes nothing", async () => {
    await applyPageBlockOp(
      "W",
      {
        kind: "insert",
        newId: "q",
        type: "para",
        data: payloadFor("para", "q"),
        afterId: "p",
      },
      countingDb,
    );
    const ran = reconcileStatements();
    expect(ran).toHaveLength(1);
    expect(ran[0]).toContain("WITH RECURSIVE members");
  });
});

describe("boot reconcile", () => {
  test("a database whose pages hold no key is a silent backfill, then clean", async () => {
    await seed({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seed({
      id: "A",
      parentId: "W",
      pageId: "W",
      type: "page",
      rank: "a0",
    });
    await seed({
      id: "B",
      parentId: "W",
      pageId: "W",
      type: "page",
      rank: "a1",
    });
    // The state before this column existed: every key NULL.
    await t.db.execute(sql`UPDATE page_blocks SET doc_rank = NULL`);

    expect(await reconcileDocRanksAtBoot(t.db)).toEqual({
      kind: "backfill",
      written: 3,
    });
    await expectInvariant("after backfill");
    expect(await reconcileDocRanksAtBoot(t.db)).toEqual({ kind: "clean" });
  });

  test("a group a writer left out of order is repaired and classified as drift", async () => {
    await seed({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await seed({
      id: "A",
      parentId: "W",
      pageId: "W",
      type: "page",
      rank: "a0",
    });
    await seed({
      id: "B",
      parentId: "W",
      pageId: "W",
      type: "page",
      rank: "a1",
    });
    // A writer bypassing the marks: swap the two sub-pages' ranks by hand.
    await t.db.execute(sql`UPDATE page_blocks SET rank = 'Zz' WHERE id = 'B'`);

    const outcome = await reconcileDocRanksAtBoot(t.db);
    expect(outcome).toEqual({
      kind: "drift",
      written: 1,
      rekeyed: 1,
      unkeyed: 0,
      partitions: ["W"],
    });
    await expectInvariant("after drift repair");
    expect(
      (await loadPages(t.db)).filter((p) => p.pageId === "W").map((p) => p.id),
    ).toEqual(["B", "A"]);
  });
});

describe("the sidebar loader reads the column", () => {
  test("a live page with no doc_rank is thrown, naming the row", async () => {
    await seed({
      id: "W",
      parentId: null,
      pageId: null,
      type: "page",
      rank: "a0",
    });
    await t.db.execute(
      sql`UPDATE page_blocks SET doc_rank = NULL WHERE id = 'W'`,
    );
    // `expect(p).rejects.toThrow()` is typed `void` under bun:test, so awaiting
    // it trips `@typescript-eslint/await-thenable`; capture the rejection.
    let caught: unknown;
    try {
      await loadPages(t.db);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toMatch(/live page W .* has no doc_rank/);
  });
});
