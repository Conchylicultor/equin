/**
 * `pages.tree.v2` — the live pages as a TREE window — on the TREE ORACLE
 * (tasks-core's `server/testing`): the real declaration compiled with the
 * real serve options (`./page-rows.ts`) against a throwaway database, through
 * the real feed, with the `page_blocks` derived `updated_at` trigger and the
 * plugin's two materialized joins (`PAGE_ROLLUPS`: the content edit time and
 * the tree's child count, both ON the feed) installed as a backend installs
 * them.
 *
 * The workload is the page tree's own (the oracle's task script is not run):
 * a page W whose sub-pages span two rank spaces — A and B under a toggle, D a
 * direct child — beside a root page X. The forest is seeded, and the drag is
 * made, through the REAL writers (`withPageForest`, `applyPageBlockOp`), so
 * `doc_rank` is what the structural-write chokepoint stores. The other steps
 * are one SQL transaction each, in the shape a writer emits.
 *
 * Subscribed: the tuples the sidebar and its neighbours read — the ROOT level
 * (`pageId isEmpty`), W's level (`pageId = W`), Recent (every page by
 * `editedAt` desc) — and two `:rows` point tuples: A, D (two pages) and A, P
 * (a page and a content paragraph, the shape `useBlockTarget` once
 * subscribed). After every step:
 *
 * - every view equals a fresh FULL load (`converged`);
 * - each level, in window order, IS document order — `docOrderRows` +
 *   `compareDocOrder`, the order the old `pages` loader derived on every load
 *   (parity): the window's own `doc_rank` order, never a client sort;
 * - every row's `editedAt` is its page's edit time recomputed from scratch —
 *   the newest `updated_at` over the page row and its live content — and its
 *   `$childCount` the number of live pages naming it as `page_id`, recounted
 *   from scratch; neither materialized table drifts from its aggregate;
 * - the costs that pin the routing: a fold toggle loads nothing, a keystroke's
 *   projection on a content block refills its page's ONE row (in the tuples
 *   holding it) and nothing in the point tuples;
 * - nothing is ever loaded FULL after the subscribe.
 *
 * The `editedAt` steps: an edit moves its page's `editedAt` forward, trashing
 * the block holding the newest stamp moves it back, and a block moving
 * between pages moves both, each recomputed. The `$childCount` steps: a page
 * inserted under W, a trash and a restore of X, P turned into a page and back
 * — each a recount of the parent, held equal to the recount from scratch.
 *
 * The A, P tuple then walks P through every membership edge: turning P into a
 * page is an entrant, turning it back an exit, and a trash / restore of it as
 * content stays out.
 *
 * Then C39: a tab still running a bundle that subscribed an old key — the
 * whole set `pages.tree`, or the legacy push resource `pages` — is refused
 * `unknown-key`, a `skew` verdict (the Reload prompt).
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/page/plugins/editor`.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { eq, sql } from "drizzle-orm";
import { z } from "zod";
import { registeredDerivedUpdatedAt } from "@plugins/database/plugins/derived-updated-at/server";
import { installDbTriggers } from "@plugins/database/plugins/db-triggers/server";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import { compileWindowQuery } from "@plugins/network/plugins/live/plugins/query-resource/server/testing";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import {
  compileCollection,
  subscribeAsOldDescriptor,
} from "@plugins/network/plugins/live/server/testing";
import { Rank } from "@plugins/primitives/plugins/rank/core";
import {
  createTreeOracle,
  type TreeLoad,
  type TreeOracle,
  type TreeStep,
} from "@plugins/tasks/plugins/tasks-core/server/testing";
import { defineBlock, textBlockSchema } from "../../core";
import { pagesTree } from "../../core/resources";
import { pageBlockHandle, PageRowSchema } from "../../core/schemas";
import { Editor } from "./block-registry";
import { insertBlocks } from "./forest-writer";
import { applyPageBlockOp } from "./handle-apply-block-op";
import { compareDocOrder, docOrderRows } from "./page-doc-order";
import { withPageForest } from "./page-forest";
import { pageRowsServeOptions } from "./page-rows";
import { PAGE_ROLLUPS } from "./rollup-spec";
import { parseBlockData } from "./parse-block-data";
import { _blocks } from "./tables";

setDefaultTimeout(120_000);

const KEY = pagesTree.key;
const ROWS_KEY = pagesTree.rows.key;
/** The keys the page tree had before: the whole set, and the legacy push resource. */
const OLD_KEYS = ["pages.tree", "pages"] as const;

// Stand-ins for the content block types (each concrete one imports this
// plugin, so importing it back would be a cycle).
const paraStub = defineBlock({
  type: "pages-tree-para",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
  defaultText: true,
});
const toggleStub = defineBlock({
  type: "pages-tree-toggle",
  schema: textBlockSchema({}),
  empty: () => ({ text: [] }),
});

/** W holds `p`, a toggle T holding A and B, then D; X sits at the root. */
const [W, X, P, T, A, B, D, E] = [
  "page-w",
  "page-x",
  "para-p",
  "toggle-t",
  "page-a",
  "page-b",
  "page-d",
  "page-e",
] as const;

let oracle: TreeOracle;
let specs: ReturnType<typeof compilePagesTree>;

/** The real declaration and serve options, compiled against the throwaway. */
function compilePagesTree() {
  return compileCollection(pagesTree, {
    ...pageRowsServeOptions,
    db: oracle.queryDb as unknown as QueryDb,
  });
}

/** Insert one row through the REAL mutator, so the reconcile places it. */
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
          data: parseBlockData(
            args.type,
            args.type === pageBlockHandle.type
              ? { title: args.id, icon: null }
              : { text: [{ text: args.id }] },
          ),
        },
      ]);
    },
    oracle.db,
  );
}

async function docRanks(): Promise<Map<string, string | null>> {
  const rows = await oracle.db
    .select({ id: _blocks.id, docRank: _blocks.docRank })
    .from(_blocks)
    .where(eq(_blocks.type, pageBlockHandle.type));
  return new Map(rows.map((r) => [r.id, r.docRank]));
}

// The subscribed window tuples: the root level, W's level, Recent.
const level = (q: Parameters<typeof pagesTree.window.window.encode>[0]) =>
  pagesTree.window.window.encode(q);
const ROOT = level({ where: { pageId: { isEmpty: true } } });
const W_LEVEL = level({ where: { pageId: W } });
const RECENT = level({ orderBy: [["editedAt", "desc"]] });

/** A window view's rows, parsed as the page rows they are (plus the tree's count). */
function viewRows(params: Record<string, string>) {
  const raw = oracle.view(KEY, params) as readonly { $childCount: number }[];
  return PageRowSchema.array()
    .parse(raw)
    .map((row, i) => ({ ...row, childCount: raw[i]!.$childCount }));
}

/** Page ids per group in document order — the old loader's derivation. */
async function documentOrder(): Promise<Record<string, string[]>> {
  const out: Record<string, Awaited<ReturnType<typeof docOrderRows>>> = {};
  for (const row of await docOrderRows(oracle.db)) {
    (out[row.pageId ?? "<root>"] ??= []).push(row);
  }
  return Object.fromEntries(
    Object.entries(out).map(([group, list]) => [
      group,
      [...list].sort(compareDocOrder).map((r) => r.id),
    ]),
  );
}

/**
 * Every live page's edit time and child count recomputed from scratch, by id:
 * the newest `updated_at` over the page row and its live content —
 * `readPageEditedAt`'s definition, spelled here without the materialized
 * table it reads — and how many live pages name it as `page_id`.
 */
async function fromScratch(): Promise<
  Record<string, { edited: number; childCount: number }>
> {
  const res = await oracle.db.execute<{
    id: string;
    edited_at: Date;
    child_count: number;
  }>(
    sql.raw(`
      SELECT p.id,
             greatest(p.updated_at, (
               SELECT max(c.updated_at) FROM page_blocks c
                WHERE c.page_id = p.id AND c.deleted_at IS NULL
             )) AS edited_at,
             (SELECT count(*)::int FROM page_blocks k
               WHERE k.page_id = p.id AND k.type = 'page'
                 AND k.deleted_at IS NULL) AS child_count
        FROM page_blocks p
       WHERE p.type = 'page' AND p.deleted_at IS NULL`),
  );
  return Object.fromEntries(
    res.rows.map((r) => [
      r.id,
      { edited: new Date(r.edited_at).getTime(), childCount: r.child_count },
    ]),
  );
}

/** The keys whose materialized row differs from its aggregate (none, when exact). */
async function rollupDrift(): Promise<string[]> {
  const keys: string[] = [];
  for (const rollup of PAGE_ROLLUPS) {
    const res = await oracle.db.execute<{ keys: string[] }>(
      sql.raw(rollup.driftSql),
    );
    keys.push(...(res.rows[0]?.keys ?? []));
  }
  return keys;
}

/** Recent's `editedAt` per page, as epoch ms (Recent holds every page). */
function viewEdited(): Record<string, number> {
  return Object.fromEntries(
    viewRows(RECENT).map((r) => [r.id, r.editedAt.getTime()]),
  );
}

async function expectParity(label: string): Promise<void> {
  const order = await documentOrder();
  const truth = await fromScratch();
  const seen: Record<string, { edited: number; childCount: number }> = {};
  for (const params of [ROOT, W_LEVEL, RECENT]) {
    for (const row of viewRows(params)) {
      seen[row.id] = {
        edited: row.editedAt.getTime(),
        childCount: row.childCount,
      };
    }
  }
  const recent = viewRows(RECENT).map((r) => r.editedAt.getTime());
  expect({
    step: label,
    root: viewRows(ROOT).map((r) => r.id),
    w: viewRows(W_LEVEL).map((r) => r.id),
    rows: seen,
    recentSorted: recent.every((t, i) => i === 0 || recent[i - 1]! >= t),
    drift: await rollupDrift(),
  }).toEqual({
    step: label,
    root: order["<root>"] ?? [],
    w: order[W] ?? [],
    rows: truth,
    recentSorted: true,
    drift: [],
  });
}

/** Loads in a fixed order, so several tuples' loads compare whatever order they drained in. */
function sortedLoads(loads: readonly TreeLoad[]): TreeLoad[] {
  return [...loads].sort((a, b) =>
    JSON.stringify(a.ids) < JSON.stringify(b.ids) ? -1 : 1,
  );
}

/**
 * Run one step and hold it to parity. `cost`, when given, pins the step's
 * loads: the window tuples' together (`loads`, a multiset — each tuple
 * holding a refilled row loads it) and the point tuples' (`rowLoads`).
 */
async function runSql(
  step: TreeStep,
  cost?: { loads: TreeLoad[]; rowLoads: TreeLoad[] },
): Promise<void> {
  const got = await oracle.run(step);
  await oracle.converged(step.label);
  await expectParity(step.label);
  if (cost === undefined) return;
  expect({
    step: step.label,
    loads: sortedLoads(got.loads[KEY] ?? []),
    rowLoads: sortedLoads(got.loads[ROWS_KEY] ?? []),
  }).toEqual({
    step: step.label,
    loads: sortedLoads(cost.loads),
    rowLoads: sortedLoads(cost.rowLoads),
  });
}

/** The ids a `:rows` view holds, sorted. */
function rowIds(params: Record<string, string>): string[] {
  return PageRowSchema.array()
    .parse(oracle.view(ROWS_KEY, params))
    .map((r) => r.id)
    .sort();
}

/**
 * Run a REAL writer, then a no-cost sync write (a fold toggle on the content
 * paragraph: it moves no stored aggregate and no column any tuple reads) so
 * the runtime has gone quiet over both.
 */
async function runWriter(
  label: string,
  write: () => Promise<unknown>,
): Promise<void> {
  await write();
  await oracle.run({
    label: `${label}.sync`,
    statements: [
      `UPDATE page_blocks SET expanded = NOT expanded WHERE id = '${P}'`,
    ],
  });
  await oracle.converged(label);
  await expectParity(label);
}

const pagePayload = (title: string) =>
  JSON.stringify({ title, icon: null }).replace(/'/g, "''");

beforeAll(async () => {
  collectContributions([
    {
      id: "pages-tree-oracle",
      contributions: [
        Editor.BlockData(pageBlockHandle),
        Editor.BlockData(paraStub),
        Editor.BlockData(toggleStub),
      ],
    },
  ]);
  oracle = await createTreeOracle({
    prefix: "pages_tree_oracle",
    persisted: [],
  });
  // The materialized joins the rows read, installed through the boot path.
  // Not the oracle's `rollups` (those are feed-exempt, routed by their
  // sources): these are ON the feed — readers are routed by their own rows.
  await installRollups(oracle.db, PAGE_ROLLUPS);
  // The derived `updated_at` trigger, as a backend installs it at boot: a
  // rename moves `updatedAt` in the same row, as in production.
  await installDbTriggers(
    oracle.db,
    registeredDerivedUpdatedAt()
      .filter((spec) => spec.table === "page_blocks")
      .map((spec) => spec.triggerSet),
  );
  specs = compilePagesTree();
  oracle.registerWindow(pagesTree, specs);
  // The seed, through the real writers (before the feed starts: nothing is
  // subscribed yet).
  await seed({ id: W, parentId: null, pageId: null, type: "page", rank: "a0" });
  await seed({ id: X, parentId: null, pageId: null, type: "page", rank: "a1" });
  await seed({
    id: P,
    parentId: W,
    pageId: W,
    type: paraStub.type,
    rank: "a0",
  });
  await seed({
    id: T,
    parentId: W,
    pageId: W,
    type: toggleStub.type,
    rank: "a1",
  });
  await seed({ id: A, parentId: T, pageId: W, type: "page", rank: "a0" });
  await seed({ id: B, parentId: T, pageId: W, type: "page", rank: "a1" });
  await seed({ id: D, parentId: W, pageId: W, type: "page", rank: "a2" });
  await oracle.start();
});

afterAll(async () => {
  await oracle?.stop();
});

describe("pages.tree.v2 — a tree window on the tree oracle", () => {
  test("every step converges to a fresh FULL load, each level in document order, counts and edit times exact; nothing loads FULL", async () => {
    for (const params of [ROOT, W_LEVEL, RECENT]) {
      await oracle.subscribe(KEY, params);
    }
    const pointParams = pagesTree.rows.point.encode([A, D]);
    await oracle.subscribe(ROWS_KEY, pointParams);
    // A page and a content paragraph: P is requested but no member.
    const contentParams = pagesTree.rows.point.encode([A, P]);
    await oracle.subscribe(ROWS_KEY, contentParams);
    await oracle.converged("seed");
    await expectParity("seed");
    expect(rowIds(contentParams)).toEqual([A]);
    expect(viewRows(ROOT).map((r) => [r.id, r.childCount])).toEqual([
      [W, 3],
      [X, 0],
    ]);
    expect(viewRows(W_LEVEL).map((r) => r.id)).toEqual([A, B, D]);
    const baseline = oracle.loadsOf(KEY).length;

    // A keystroke burst's `data.text` projection on a content block: no page
    // row changed, but W's content did — its stored edit time moves, so W's
    // one row refills in each tuple holding it (the root level and Recent).
    // Recent (no level filter) also probes P by id in the same load: a `data`
    // write reaches a window whose columns read `data` (`title`), and only a
    // load can tell a non-page (the base `where`) — it finds nothing. Nothing
    // in the point tuples: P is no member, and W is not held.
    const beforeTyping = viewEdited()[W]!;
    await runSql(
      {
        label: "typing",
        statements: [
          `UPDATE page_blocks SET data = '{"text":[{"text":"typing…"}]}'::jsonb WHERE id = '${P}'`,
        ],
      },
      { loads: [{ ids: [W] }, { ids: [W, P] }], rowLoads: [] },
    );
    expect(viewEdited()[W]!).toBeGreaterThan(beforeTyping);

    // A fold toggle on a content block moves no stored aggregate and no
    // column any tuple reads: nothing loads.
    await runSql(
      {
        label: "fold",
        statements: [
          `UPDATE page_blocks SET expanded = NOT expanded WHERE id = '${T}'`,
        ],
      },
      { loads: [], rowLoads: [] },
    );

    // A rename is the page row's refill — and W's, whose content the sub-page
    // row D is (its edit time moved).
    await runSql({
      label: "rename",
      statements: [
        `UPDATE page_blocks SET data = '${pagePayload("renamed")}'::jsonb WHERE id = '${D}'`,
      ],
    });

    // Drag the toggle (holding A and B) after D: no page row is named, yet
    // the group's document order becomes D, A, B — W's level re-orders.
    await runWriter("toggle.drag", () =>
      applyPageBlockOp(
        W,
        {
          kind: "move",
          blockId: T,
          parentId: W,
          targetId: D,
          zone: "after",
        },
        oracle.db,
      ),
    );
    expect(viewRows(W_LEVEL).map((r) => r.id)).toEqual([D, A, B]);

    // A page created at the end of W, as a writer emits it: the row, then its
    // `doc_rank`, in one transaction — an entrant in W's level, W recounted.
    const lastKey = [...(await docRanks()).entries()]
      .filter(([id]) => [A, B, D].includes(id as typeof A))
      .map(([, k]) => k!)
      .sort()
      .at(-1)!;
    await runSql({
      label: "insert",
      statements: [
        "BEGIN",
        `INSERT INTO page_blocks (id, page_id, parent_id, type, data, rank)
         VALUES ('${E}', '${W}', '${W}', 'page', '${pagePayload(E)}'::jsonb, 'a8')`,
        `UPDATE page_blocks SET doc_rank = '${Rank.between(Rank.from(lastKey), null).toString()}' WHERE id = '${E}'`,
        "COMMIT",
      ],
    });
    expect(viewRows(ROOT).find((r) => r.id === W)?.childCount).toBe(4);

    // E moves under X: an exit from W's level, both parents recounted.
    await runSql({
      label: "E.move-to-X",
      statements: [
        `UPDATE page_blocks SET parent_id = '${X}', page_id = '${X}' WHERE id = '${E}'`,
      ],
    });
    expect(viewRows(ROOT).map((r) => [r.id, r.childCount])).toEqual([
      [W, 3],
      [X, 1],
    ]);

    // A trash is a where-flip exit; its restore an entrant.
    await runSql({
      label: "trash",
      statements: [
        `UPDATE page_blocks SET deleted_at = now(), trash_entry_id = 'te-x' WHERE id = '${X}'`,
      ],
    });
    expect(viewRows(ROOT).map((r) => r.id)).toEqual([W]);
    await runSql({
      label: "restore",
      statements: [
        `UPDATE page_blocks SET deleted_at = NULL, trash_entry_id = NULL WHERE id = '${X}'`,
      ],
    });

    // P through every membership edge, in the A, P tuple. Turning P into a
    // page (a `type` write, with the `doc_rank` the reconcile would mint —
    // first in W's group) is an entrant in W's level and the tuple, and W's
    // recount.
    const ranks = await docRanks();
    const firstInW = Rank.between(null, Rank.from(ranks.get(D)!)).toString();
    await runSql({
      label: "P.turn-into-page",
      statements: [
        `UPDATE page_blocks SET type = 'page', data = '${pagePayload(P)}'::jsonb,
                doc_rank = '${firstInW}' WHERE id = '${P}'`,
      ],
    });
    expect(rowIds(contentParams)).toEqual([P, A].sort());
    expect(viewRows(W_LEVEL)[0]!.id).toBe(P);

    // Back into content: a where-flip exit, W recounted.
    await runSql({
      label: "P.turn-into-content",
      statements: [
        `UPDATE page_blocks SET type = '${paraStub.type}',
                data = '{"text":[{"text":"back"}]}'::jsonb, doc_rank = NULL
         WHERE id = '${P}'`,
      ],
    });
    expect(rowIds(contentParams)).toEqual([A]);

    // A trash and a restore of P as content: P is no page either way, so
    // nothing enters. P holds W's newest stamp (it was just written), so
    // trashing it moves W's `editedAt` BACK to the newest of what is left.
    const beforeTrash = viewEdited()[W]!;
    await runSql({
      label: "P.trash",
      statements: [
        `UPDATE page_blocks SET deleted_at = now(), trash_entry_id = 'te-p' WHERE id = '${P}'`,
      ],
    });
    expect(viewEdited()[W]!).toBeLessThan(beforeTrash);
    await runSql({
      label: "P.restore",
      statements: [
        `UPDATE page_blocks SET deleted_at = NULL, trash_entry_id = NULL WHERE id = '${P}'`,
      ],
    });
    expect(rowIds(contentParams)).toEqual([A]);

    // P moves from W to the root page X: `page_id` is the joins' fk, so both
    // pages re-aggregate — X gains P's stamp, W loses it.
    const beforeMove = viewEdited();
    await runSql({
      label: "P.move-to-X",
      statements: [
        `UPDATE page_blocks SET parent_id = '${X}', page_id = '${X}' WHERE id = '${P}'`,
      ],
    });
    const afterMove = viewEdited();
    expect(afterMove[X]!).toBeGreaterThan(beforeMove[X]!);
    expect(afterMove[W]!).toBeLessThan(beforeMove[W]!);

    expect(
      oracle
        .loadsOf(KEY)
        .slice(baseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
    oracle.unsubscribe(ROWS_KEY, contentParams);
    oracle.unsubscribe(ROWS_KEY, pointParams);
    for (const params of [ROOT, W_LEVEL, RECENT]) {
      oracle.unsubscribe(KEY, params);
    }
  });

  test("a live page with no doc_rank fails the load loudly — never sorted anywhere", async () => {
    await oracle.db.execute(
      sql.raw(`UPDATE page_blocks SET doc_rank = NULL WHERE id = '${D}'`),
    );
    const { loader } = compileWindowQuery(
      pagesTree.window,
      specs.window,
    ).serverOpts;
    const rows = await loader(W_LEVEL as never);
    expect(() => pagesTree.window.schema.parse(rows)).toThrow();
  });
});

describe("C39 — a tab on an old key", () => {
  for (const key of OLD_KEYS) {
    test(`"${key}" is refused \`unknown-key\`, a \`skew\` verdict`, async () => {
      const old = await subscribeAsOldDescriptor(
        { key, schema: z.array(PageRowSchema) },
        { handler: oracle.runtime.notificationsWsHandler },
      );
      expect(old).toEqual({
        kind: "refused",
        reason: "unknown-key",
        verdict: "skew",
      });
    });
  }
});
