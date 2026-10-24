/**
 * `page-links.sources` as an `all` collection, on the TREE ORACLE (tasks-core's
 * `server/testing`): the real declaration compiled with the real serve options
 * (`./link-source-rows.ts`) against a throwaway database, through the real
 * feed. Not preloaded, so not persisted: the set is subscribed, never an L2
 * alias.
 *
 * The workload is the link graph's own (the oracle's task script is not run):
 * root pages W, X, Y, Z, each with a content block, and edges X→W (from two
 * blocks), Y→W, W→X and a self-link W→W. Every step is one SQL transaction in
 * the shape the reindexer, the trash hook or the editor's writers emit.
 *
 * After every step:
 *
 * - the subscribed `{}` view and the `:rows` point view (over W, X) equal a
 *   fresh FULL load;
 * - the set equals the old `page-links` loader (DISTINCT `(source, target)`
 *   over `page_links`, ordered by source then target) folded per live target
 *   page with self-links dropped, as the sidebar folded it (parity);
 * - both readers' costs are exact: an edge insert or delete refills its target
 *   page's row alone; a keystroke's projection on a content block and a page
 *   rename load nothing; a page insert is one refill and one `orderOf`; a
 *   trash an exit after its one-id probe;
 * - nothing is ever loaded FULL after the subscribe.
 *
 * Then C39: a tab still running a bundle that subscribed the old key
 * `page-links` is refused `unknown-key`, a `skew` verdict (the Reload prompt).
 *
 * Requires a running Postgres cluster (started by ./equin build).
 * Run: `./equin test plugins/page/plugins/links`.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { asc, eq, sql } from "drizzle-orm";
import { z } from "zod";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import {
  compileCollection,
  subscribeAsOldDescriptor,
} from "@plugins/network/plugins/live/server/testing";
import {
  liveBlocks,
  PAGE_BLOCK_TYPE,
} from "@plugins/page/plugins/editor/server";
import {
  createTreeOracle,
  type TreeLoad,
  type TreeOracle,
  type TreeStep,
} from "@plugins/tasks/plugins/tasks-core/server/testing";
import { pageLinkSources } from "../../core/resources";
import {
  PageLinkSourcesRowSchema,
  type PageLinkSourcesRow,
} from "../../core/schemas";
import { linkSourceRowsServeOptions } from "./link-source-rows";
import { _pageLinks } from "./tables";

setDefaultTimeout(120_000);

const KEY = pageLinkSources.key;
const ROWS_KEY = pageLinkSources.rows.key;
/** The key page-links had as a legacy push resource, before the rename. */
const OLD_KEY = "page-links";

/** Four root pages; `<page>-c` is a content block in each, `x-c2` a second one in X. */
const [W, X, Y, Z, E] = [
  "page-w",
  "page-x",
  "page-y",
  "page-z",
  "page-e",
] as const;
const content = (page: string) => `${page}-c`;
const X_C2 = "page-x-c2";

let oracle: TreeOracle;

const q = (s: string) => `'${s.replace(/'/g, "''")}'`;

const pageRow = (id: string, rank: string) =>
  `INSERT INTO page_blocks (id, page_id, parent_id, type, data, rank)
   VALUES (${q(id)}, NULL, NULL, 'page', ${q(JSON.stringify({ title: id, icon: null }))}::jsonb, ${q(rank)})`;
const contentRow = (id: string, page: string, rank: string) =>
  `INSERT INTO page_blocks (id, page_id, parent_id, type, data, rank)
   VALUES (${q(id)}, ${q(page)}, ${q(page)}, 'text', '{"text":[]}'::jsonb, ${q(rank)})`;
const edge = (source: string, target: string, block: string) =>
  `INSERT INTO page_links (source_page_id, target_page_id, source_block_id)
   VALUES (${q(source)}, ${q(target)}, ${q(block)})`;

/**
 * The old `page-links` loader, verbatim (one row per page PAIR), folded the
 * way the sidebar folded it — self-links dropped, sources per target in the
 * loader's order — over the live pages the new set holds.
 */
async function oldLoaderFolded(): Promise<PageLinkSourcesRow[]> {
  const edges = await oracle.db
    .selectDistinct({
      sourcePageId: _pageLinks.sourcePageId,
      targetPageId: _pageLinks.targetPageId,
    })
    .from(_pageLinks)
    .orderBy(asc(_pageLinks.sourcePageId), asc(_pageLinks.targetPageId));
  const byTarget = new Map<string, string[]>();
  for (const e of edges) {
    if (e.sourcePageId === e.targetPageId) continue;
    const list = byTarget.get(e.targetPageId);
    if (list) list.push(e.sourcePageId);
    else byTarget.set(e.targetPageId, [e.sourcePageId]);
  }
  const pages = await oracle.db
    .select({ id: liveBlocks.id })
    .from(liveBlocks)
    .where(eq(liveBlocks.type, PAGE_BLOCK_TYPE))
    .orderBy(asc(liveBlocks.id));
  return pages.map((p) => ({ id: p.id, linkedFrom: byTarget.get(p.id) ?? [] }));
}

async function expectParity(label: string): Promise<void> {
  const view = PageLinkSourcesRowSchema.array().parse(oracle.view(KEY));
  expect({ step: label, rows: view }).toEqual({
    step: label,
    rows: await oldLoaderFolded(),
  });
}

/** What a step must cost: the set's loads and `orderOf` calls, and the `:rows` (W, X) reader's loads. */
interface StepCost {
  loads: TreeLoad[];
  orderOf: number;
  rowLoads: TreeLoad[];
}
const NOTHING: StepCost = { loads: [], orderOf: 0, rowLoads: [] };

async function runStep(step: TreeStep, cost: StepCost): Promise<void> {
  const got = await oracle.run(step);
  await oracle.converged(step.label);
  await expectParity(step.label);
  expect({
    step: step.label,
    loads: got.loads[KEY] ?? [],
    orderOf: got.orderOf[KEY] ?? 0,
    rowLoads: got.loads[ROWS_KEY] ?? [],
  }).toEqual({ step: step.label, ...cost });
}

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "page_link_sources_oracle",
    persisted: [],
  });
  oracle.registerAll(
    pageLinkSources,
    compileCollection(pageLinkSources, {
      ...linkSourceRowsServeOptions,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  // The seed, before the feed starts (nothing is subscribed yet).
  await oracle.db.execute(
    sql.raw(
      [
        pageRow(W, "a0"),
        pageRow(X, "a1"),
        pageRow(Y, "a2"),
        pageRow(Z, "a3"),
        contentRow(content(W), W, "a0"),
        contentRow(content(X), X, "a0"),
        contentRow(X_C2, X, "a1"),
        contentRow(content(Y), Y, "a0"),
        contentRow(content(Z), Z, "a0"),
        edge(X, W, content(X)),
        edge(X, W, X_C2),
        edge(Y, W, content(Y)),
        edge(W, X, content(W)),
        edge(W, W, content(W)),
      ].join(";\n"),
    ),
  );
  await oracle.start();
});

afterAll(async () => {
  await oracle?.stop();
});

describe("page-links.sources — an `all` collection on the tree oracle", () => {
  test("every step converges to a fresh FULL load at its exact cost, equal to the old loader; nothing loads FULL", async () => {
    await oracle.subscribe(KEY);
    const pointParams = pageLinkSources.rows.point.encode([W, X]);
    await oracle.subscribe(ROWS_KEY, pointParams);
    await oracle.converged("seed");
    await expectParity("seed");
    // One source per page pair (X links to W from two blocks), the self-link
    // dropped, `[]` for a page nothing links to.
    expect(PageLinkSourcesRowSchema.array().parse(oracle.view(KEY))).toEqual([
      { id: W, linkedFrom: [X, Y] },
      { id: X, linkedFrom: [W] },
      { id: Y, linkedFrom: [] },
      { id: Z, linkedFrom: [] },
    ]);
    const baseline = oracle.loadsOf(KEY).length;

    // A keystroke burst's `data.text` projection on a content block: the
    // route reads no column it writes, so nothing loads.
    await runStep(
      {
        label: "typing",
        statements: [
          `UPDATE page_blocks SET data = '{"text":[{"text":"typing…"}]}'::jsonb WHERE id = ${q(content(W))}`,
        ],
      },
      NOTHING,
    );

    // A rename writes the page row's `data`, which no field reads.
    await runStep(
      {
        label: "rename",
        statements: [
          `UPDATE page_blocks SET data = ${q(JSON.stringify({ title: "renamed", icon: null }))}::jsonb WHERE id = ${q(X)}`,
        ],
      },
      NOTHING,
    );

    // An edge insert (Z starts linking to X) refills X alone, in both readers.
    await runStep(
      { label: "edge.insert", statements: [edge(Z, X, content(Z))] },
      { loads: [{ ids: [X] }], orderOf: 0, rowLoads: [{ ids: [X] }] },
    );

    // An edge into a page no point reader holds: the set's refill only.
    await runStep(
      { label: "edge.insert.unwatched", statements: [edge(W, Z, content(W))] },
      { loads: [{ ids: [Z] }], orderOf: 0, rowLoads: [] },
    );

    // An edge delete (Y stops linking to W), as the reindexer's diff emits it.
    await runStep(
      {
        label: "edge.delete",
        statements: [
          `DELETE FROM page_links WHERE source_page_id = ${q(Y)} AND target_page_id = ${q(W)}`,
        ],
      },
      { loads: [{ ids: [W] }], orderOf: 0, rowLoads: [{ ids: [W] }] },
    );

    // One of X's two linking blocks drops its link: the pair survives, the
    // row is refilled to the same value.
    await runStep(
      {
        label: "edge.delete.one-of-two",
        statements: [
          `DELETE FROM page_links WHERE source_block_id = ${q(X_C2)} AND target_page_id = ${q(W)}`,
        ],
      },
      { loads: [{ ids: [W] }], orderOf: 0, rowLoads: [{ ids: [W] }] },
    );

    // A page created: one refill and one `orderOf`.
    await runStep(
      { label: "page.insert", statements: [pageRow(E, "a4")] },
      { loads: [{ ids: [E] }], orderOf: 1, rowLoads: [] },
    );

    // A trashed target is a where-flip exit: probed by id (the base `where`
    // reads `deleted_at`), found gone, and leaves — its edges with it.
    await runStep(
      {
        label: "trash",
        statements: [
          `UPDATE page_blocks SET deleted_at = now(), trash_entry_id = 'te-z' WHERE id = ${q(Z)}`,
        ],
      },
      { loads: [{ ids: [Z] }], orderOf: 0, rowLoads: [] },
    );

    expect(
      oracle
        .loadsOf(KEY)
        .slice(baseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
    oracle.unsubscribe(ROWS_KEY, pointParams);
    oracle.unsubscribe(KEY);
  });
});

describe("C39 — a tab on the old `page-links` resource", () => {
  test("is refused `unknown-key`, a `skew` verdict", async () => {
    const old = await subscribeAsOldDescriptor(
      {
        key: OLD_KEY,
        schema: z.array(
          z.object({ sourcePageId: z.string(), targetPageId: z.string() }),
        ),
      },
      { handler: oracle.runtime.notificationsWsHandler },
    );
    expect(old).toEqual({
      kind: "refused",
      reason: "unknown-key",
      verdict: "skew",
    });
  });
});
