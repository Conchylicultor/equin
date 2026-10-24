/**
 * `pages.tree` as an `all` collection, on the TREE ORACLE (tasks-core's
 * `server/testing`): the real declaration compiled with the real serve options
 * (`./page-rows.ts`) against a throwaway database, through the real feed, with
 * the `page_blocks` derived `updated_at` trigger installed as a backend
 * installs it. Not preloaded, so not persisted: the set is subscribed, never
 * an L2 alias.
 *
 * The workload is the page tree's own (the oracle's task script is not run):
 * a page W whose sub-pages span two rank spaces — A and B under a toggle, D a
 * direct child — beside a root page X. The forest is seeded, and the drag is
 * made, through the REAL writers (`withPageForest`, `applyPageBlockOp`), so
 * `doc_rank` is what the structural-write chokepoint stores. The other steps
 * are one SQL transaction each, in the shape a writer emits.
 *
 * After every step:
 *
 * - the subscribed `{}` view and both `:rows` point views equal a fresh FULL
 *   load: one over A, D (two pages), and one over A, P — a page and a content
 *   paragraph, the shape `useBlockTarget` once subscribed;
 * - each `pageId` group of the set, sorted by `docRank`, is document order —
 *   `docOrderRows` + `compareDocOrder`, the order the old `pages` loader
 *   derived on every load (parity);
 * - every row's `editedAt` is its page's edit time recomputed from scratch —
 *   the newest `updated_at` over the page row and its live content — and the
 *   `page_content_edited_at` rollup has no drift from its aggregate;
 * - both readers' costs are exact: a keystroke's projection on a content block
 *   is the refill of its page's one row (its `editedAt` moved); a rename is
 *   that page's refill, plus its parent page's (the sub-page row is content of
 *   it); a toggle drag refills exactly the pages the reconcile re-minted and
 *   the page holding the toggle; an insert or a restore is one refill and one
 *   `orderOf`; a trash an exit after its one-id probe;
 * - nothing is ever loaded FULL after the subscribe.
 *
 * The `editedAt` steps: an edit moves its page's `editedAt` forward, trashing
 * the block holding the newest stamp moves it back, and a block moving
 * between pages refills both, each recomputed.
 *
 * The A, P tuple then walks P through every membership edge: a value-only
 * write to P while it is no member loads NOTHING in it (the point tuple drops
 * a value-only change to an id it does not hold); turning P into a page is an
 * entrant (the positive control), a write to it then a refill, turning it back
 * an exit, and a trash / restore of it as content stays membership — probed,
 * and nothing enters. Every write to P as content refills W, the page whose
 * content it is (never in either point tuple, so neither loads it).
 *
 * Then C39: a tab still running a bundle that subscribed the old key `pages`
 * is refused `unknown-key`, a `skew` verdict (the Reload prompt).
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
import {
  installDerivedUpdatedAt,
  registeredDerivedUpdatedAt,
} from "@plugins/database/plugins/derived-updated-at/server";
import { collectContributions } from "@plugins/framework/plugins/server-core/core";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
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
import {
  pageBlockHandle,
  PageRowSchema,
  type PageRow,
} from "../../core/schemas";
import { Editor } from "./block-registry";
import { insertBlocks } from "./forest-writer";
import { applyPageBlockOp } from "./handle-apply-block-op";
import { compareDocOrder, docOrderRows } from "./page-doc-order";
import { withPageForest } from "./page-forest";
import { pageRowsServeOptions } from "./page-rows";
import { pageContentEditedAt } from "./rollup-spec";
import { parseBlockData } from "./parse-block-data";
import { _blocks } from "./tables";

setDefaultTimeout(120_000);

const KEY = pagesTree.key;
const ROWS_KEY = pagesTree.rows.key;
/** The key the page tree had as a legacy push resource, before the rename. */
const OLD_KEY = "pages";

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

/** Page ids per group: the set's rows sorted by `docRank`. */
function setOrder(rows: readonly PageRow[]): Record<string, string[]> {
  const out: Record<string, PageRow[]> = {};
  for (const row of rows) (out[row.pageId ?? "<root>"] ??= []).push(row);
  return Object.fromEntries(
    Object.entries(out).map(([group, list]) => [
      group,
      [...list]
        .sort((a, b) => Rank.compare(a.docRank, b.docRank))
        .map((r) => r.id),
    ]),
  );
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
 * Every live page's edit time recomputed from scratch, by id: the newest
 * `updated_at` over the page row and its live content — `readPageEditedAt`'s
 * definition, spelled here without the rollup it reads.
 */
async function editedFromScratch(): Promise<Record<string, number>> {
  const res = await oracle.db.execute<{ id: string; edited_at: Date }>(
    sql.raw(`
      SELECT p.id, greatest(p.updated_at, (
               SELECT max(c.updated_at) FROM page_blocks c
                WHERE c.page_id = p.id AND c.deleted_at IS NULL
             )) AS edited_at
        FROM page_blocks p
       WHERE p.type = 'page' AND p.deleted_at IS NULL`),
  );
  return Object.fromEntries(
    res.rows.map((r) => [r.id, new Date(r.edited_at).getTime()]),
  );
}

/** The keys whose rollup row differs from its aggregate (none, when exact). */
async function rollupDrift(): Promise<string[]> {
  const res = await oracle.db.execute<{ keys: string[] }>(
    sql.raw(pageContentEditedAt.driftSql),
  );
  return res.rows[0]!.keys;
}

/** The set's `editedAt` per page, as epoch ms. */
function viewEdited(): Record<string, number> {
  return Object.fromEntries(
    PageRowSchema.array()
      .parse(oracle.view(KEY))
      .map((r) => [r.id, r.editedAt.getTime()]),
  );
}

async function expectParity(label: string): Promise<void> {
  const view = PageRowSchema.array().parse(oracle.view(KEY));
  expect({
    step: label,
    order: setOrder(view),
    edited: viewEdited(),
    drift: await rollupDrift(),
  }).toEqual({
    step: label,
    order: await documentOrder(),
    edited: await editedFromScratch(),
    drift: [],
  });
}

/**
 * What a step must cost: the set's loads and `orderOf` calls, and the `:rows`
 * readers' loads — both tuples' together (a load names its ids, not its
 * tuple), compared as a multiset since the two tuples drain in either order.
 */
interface StepCost {
  loads: TreeLoad[];
  orderOf: number;
  rowLoads: TreeLoad[];
}
const NOTHING: StepCost = { loads: [], orderOf: 0, rowLoads: [] };

/** Loads in a fixed order, so two tuples' loads compare whatever order they drained in. */
function sortedLoads(loads: readonly TreeLoad[]): TreeLoad[] {
  return [...loads].sort((a, b) =>
    JSON.stringify(a.ids) < JSON.stringify(b.ids) ? -1 : 1,
  );
}

async function runSql(step: TreeStep, cost: StepCost): Promise<void> {
  const got = await oracle.run(step);
  await oracle.converged(step.label);
  await expectParity(step.label);
  expect({
    step: step.label,
    loads: got.loads[KEY] ?? [],
    orderOf: got.orderOf[KEY] ?? 0,
    rowLoads: sortedLoads(got.loads[ROWS_KEY] ?? []),
  }).toEqual({
    step: step.label,
    ...cost,
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
 * paragraph: no member of the set, and a value-only write to an id the A, P
 * tuple does not hold — so it loads nothing) through the oracle so the
 * runtime has gone quiet over both. The writer's own changes commit — and so
 * route — first; the loads since the writer started are its cost. (`orderOf`
 * is counted per `run`, so a writer step pins loads only.)
 */
async function runWriter(
  label: string,
  write: () => Promise<unknown>,
): Promise<{ loads: readonly TreeLoad[]; rowLoads: readonly TreeLoad[] }> {
  const from = oracle.loadsOf(KEY).length;
  const rowsFrom = oracle.loadsOf(ROWS_KEY).length;
  await write();
  await oracle.run({
    label: `${label}.sync`,
    statements: [
      `UPDATE page_blocks SET expanded = NOT expanded WHERE id = '${P}'`,
    ],
  });
  await oracle.converged(label);
  await expectParity(label);
  return {
    loads: oracle.loadsOf(KEY).slice(from),
    rowLoads: oracle.loadsOf(ROWS_KEY).slice(rowsFrom),
  };
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
  // The content rollup `editedAt` reads, installed through the boot path; its
  // source (`page_blocks`) carries the route.
  oracle = await createTreeOracle({
    prefix: "pages_tree_oracle",
    persisted: [],
    rollups: [pageContentEditedAt],
  });
  // The derived `updated_at` trigger, as a backend installs it at boot: a
  // rename moves `updatedAt` in the same row, as in production.
  await installDerivedUpdatedAt(
    oracle.db,
    registeredDerivedUpdatedAt().filter((spec) => spec.table === "page_blocks"),
  );
  specs = compilePagesTree();
  oracle.registerAll(pagesTree, specs);
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

describe("pages.tree — an `all` collection on the tree oracle", () => {
  test("every step converges to a fresh FULL load at its exact cost, in document order; nothing loads FULL", async () => {
    await oracle.subscribe(KEY);
    const pointParams = pagesTree.rows.point.encode([A, D]);
    await oracle.subscribe(ROWS_KEY, pointParams);
    // A page and a content paragraph: P is requested but no member.
    const contentParams = pagesTree.rows.point.encode([A, P]);
    await oracle.subscribe(ROWS_KEY, contentParams);
    await oracle.converged("seed");
    await expectParity("seed");
    expect(rowIds(contentParams)).toEqual([A]);
    expect(setOrder(PageRowSchema.array().parse(oracle.view(KEY)))).toEqual({
      "<root>": [W, X],
      [W]: [A, B, D],
    });
    const baseline = oracle.loadsOf(KEY).length;

    // A keystroke burst's `data.text` projection on a content block: no page
    // row changed, but W's content did — its `editedAt` moves, so W's one row
    // refills (never the legacy loader's membership select + doc-order CTE).
    // Not in the A, P tuple, which requests P: a `data`-only write moves no
    // column its membership reads, P is no member, and W is not held.
    const beforeTyping = viewEdited()[W]!;
    await runSql(
      {
        label: "typing",
        statements: [
          `UPDATE page_blocks SET data = '{"text":[{"text":"typing…"}]}'::jsonb WHERE id = '${P}'`,
        ],
      },
      { loads: [{ ids: [W] }], orderOf: 0, rowLoads: [] },
    );
    // The edit moved W's edit time forward (recomputed by `expectParity`).
    expect(viewEdited()[W]!).toBeGreaterThan(beforeTyping);

    // A fold toggle on a content block moves no column the rollup reads
    // (`updated_at` is derived and ignores `expanded`): nothing loads.
    await runSql(
      {
        label: "fold",
        statements: [
          `UPDATE page_blocks SET expanded = NOT expanded WHERE id = '${T}'`,
        ],
      },
      NOTHING,
    );

    // A rename is the page row's refill, in both readers — and W's, whose
    // content the sub-page row D is.
    await runSql(
      {
        label: "rename",
        statements: [
          `UPDATE page_blocks SET data = '${pagePayload("renamed")}'::jsonb WHERE id = '${D}'`,
        ],
      },
      { loads: [{ ids: [D, W].sort() }], orderOf: 0, rowLoads: [{ ids: [D] }] },
    );

    // Drag the toggle (holding A and B) after D: no page row is named, yet
    // the group's document order becomes D, A, B. The reconcile re-mints the
    // fewest keys that restore it, and exactly those pages are refilled.
    const before = await docRanks();
    const drag = await runWriter("toggle.drag", () =>
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
    const after = await docRanks();
    const reminted = [...after.keys()]
      .filter((id) => after.get(id) !== before.get(id))
      .sort();
    expect(reminted.length).toBeGreaterThan(0);
    // Plus W, whose content T is (the move stamps T's `updated_at`), and T
    // itself: the writer's later statements on T arrive while W's refill is
    // pending, so the set is no longer quiescent and the runtime keeps T's
    // value-only change rather than dropping it (a non-member: its one-id
    // probe finds nothing to load).
    expect(drag.loads).toEqual([{ ids: [...reminted, W, T].sort() }]);
    // Each point tuple refills the re-minted pages it holds; the sync fold
    // toggle on P costs the A, P tuple nothing (a value-only write, no member).
    const heldBy = (ids: readonly string[]): TreeLoad[] => {
      const held = reminted.filter((id) => ids.includes(id));
      return held.length > 0 ? [{ ids: held }] : [];
    };
    expect(sortedLoads(drag.rowLoads)).toEqual(
      sortedLoads([...heldBy([A, D]), ...heldBy([A, P])]),
    );
    expect(setOrder(PageRowSchema.array().parse(oracle.view(KEY)))[W]).toEqual([
      D,
      A,
      B,
    ]);

    // A page created at the end of W, as a writer emits it: the row, then its
    // `doc_rank`, in one transaction. One refill and one `orderOf` — the
    // refill W's too, whose content the new sub-page row is.
    const lastKey = [...(await docRanks()).entries()]
      .filter(([id]) => [A, B, D].includes(id as typeof A))
      .map(([, k]) => k!)
      .sort()
      .at(-1)!;
    await runSql(
      {
        label: "insert",
        statements: [
          "BEGIN",
          `INSERT INTO page_blocks (id, page_id, parent_id, type, data, rank)
           VALUES ('${E}', '${W}', '${W}', 'page', '${pagePayload(E)}'::jsonb, 'a8')`,
          `UPDATE page_blocks SET doc_rank = '${Rank.between(Rank.from(lastKey), null).toString()}' WHERE id = '${E}'`,
          "COMMIT",
        ],
      },
      { loads: [{ ids: [E, W].sort() }], orderOf: 1, rowLoads: [] },
    );

    // A trash is a where-flip exit: the row is probed by id (the base
    // `where` reads `deleted_at`), found gone, and leaves — one one-id load, no
    // `orderOf`. Its restore is an entrant.
    await runSql(
      {
        label: "trash",
        statements: [
          `UPDATE page_blocks SET deleted_at = now(), trash_entry_id = 'te-x' WHERE id = '${X}'`,
        ],
      },
      { loads: [{ ids: [X] }], orderOf: 0, rowLoads: [] },
    );
    await runSql(
      {
        label: "restore",
        statements: [
          `UPDATE page_blocks SET deleted_at = NULL, trash_entry_id = NULL WHERE id = '${X}'`,
        ],
      },
      { loads: [{ ids: [X] }], orderOf: 1, rowLoads: [] },
    );

    // P through every membership edge, in the A, P tuple. A positive control
    // first: turning P into a page (a `type` write, with the `doc_rank` the
    // reconcile would mint — first in W's group, before D) is an entrant, in
    // the set (one refill, one `orderOf`) and in the tuple.
    const ranks = await docRanks();
    const firstInW = Rank.between(null, Rank.from(ranks.get(D)!)).toString();
    await runSql(
      {
        label: "P.turn-into-page",
        statements: [
          `UPDATE page_blocks SET type = 'page', data = '${pagePayload(P)}'::jsonb,
                  doc_rank = '${firstInW}' WHERE id = '${P}'`,
        ],
      },
      {
        loads: [{ ids: [P, W].sort() }],
        orderOf: 1,
        rowLoads: [{ ids: [P] }],
      },
    );
    expect(rowIds(contentParams)).toEqual([P, A].sort());

    // A data write to P, now a member: its refill, in the set and the tuple.
    await runSql(
      {
        label: "P.member-write",
        statements: [
          `UPDATE page_blocks SET data = '${pagePayload("P typed")}'::jsonb WHERE id = '${P}'`,
        ],
      },
      { loads: [{ ids: [P, W].sort() }], orderOf: 0, rowLoads: [{ ids: [P] }] },
    );

    // Back into content: a where-flip exit — one one-id probe in each reader,
    // found gone, no `orderOf`.
    await runSql(
      {
        label: "P.turn-into-content",
        statements: [
          `UPDATE page_blocks SET type = '${paraStub.type}',
                  data = '{"text":[{"text":"back"}]}'::jsonb, doc_rank = NULL
           WHERE id = '${P}'`,
        ],
      },
      { loads: [{ ids: [P, W].sort() }], orderOf: 0, rowLoads: [{ ids: [P] }] },
    );
    expect(rowIds(contentParams)).toEqual([A]);

    // A trash and a restore of P as content: `deleted_at` is a column the
    // membership reads, so each stays a membership change — probed by id in
    // the set and the tuple — yet P is no page either way, so nothing enters.
    // P holds W's newest stamp (it was just written), so trashing it moves
    // W's `editedAt` BACK to the newest of what is left.
    const beforeTrash = viewEdited()[W]!;
    await runSql(
      {
        label: "P.trash",
        statements: [
          `UPDATE page_blocks SET deleted_at = now(), trash_entry_id = 'te-p' WHERE id = '${P}'`,
        ],
      },
      { loads: [{ ids: [P, W].sort() }], orderOf: 0, rowLoads: [{ ids: [P] }] },
    );
    expect(viewEdited()[W]!).toBeLessThan(beforeTrash);
    await runSql(
      {
        label: "P.restore",
        statements: [
          `UPDATE page_blocks SET deleted_at = NULL, trash_entry_id = NULL WHERE id = '${P}'`,
        ],
      },
      { loads: [{ ids: [P, W].sort() }], orderOf: 0, rowLoads: [{ ids: [P] }] },
    );
    expect(rowIds(contentParams)).toEqual([A]);

    // And typing into P, a non-member again: W's refill (its content moved),
    // nothing in either point tuple.
    await runSql(
      {
        label: "P.typing-again",
        statements: [
          `UPDATE page_blocks SET data = '{"text":[{"text":"typing again…"}]}'::jsonb WHERE id = '${P}'`,
        ],
      },
      { loads: [{ ids: [W] }], orderOf: 0, rowLoads: [] },
    );

    // P moves from W to the root page X: `page_id` is the rollup's carry, so
    // both pages re-aggregate and refill — X gains P's stamp, W loses it.
    const beforeMove = viewEdited();
    await runSql(
      {
        label: "P.move-to-X",
        statements: [
          `UPDATE page_blocks SET parent_id = '${X}', page_id = '${X}' WHERE id = '${P}'`,
        ],
      },
      { loads: [{ ids: [W, X].sort() }], orderOf: 0, rowLoads: [] },
    );
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
    oracle.unsubscribe(KEY);
  });

  test("a live page with no doc_rank fails the load loudly — never sorted anywhere", async () => {
    await oracle.db.execute(
      sql.raw(`UPDATE page_blocks SET doc_rank = NULL WHERE id = '${D}'`),
    );
    const rows = await specs.all.loader({});
    expect(() => pagesTree.all.schema.parse(rows)).toThrow();
  });
});

describe("C39 — a tab on the old `pages` resource", () => {
  test("is refused `unknown-key`, a `skew` verdict", async () => {
    const old = await subscribeAsOldDescriptor(
      { key: OLD_KEY, schema: z.array(PageRowSchema) },
      { handler: oracle.runtime.notificationsWsHandler },
    );
    expect(old).toEqual({
      kind: "refused",
      reason: "unknown-key",
      verdict: "skew",
    });
  });
});
