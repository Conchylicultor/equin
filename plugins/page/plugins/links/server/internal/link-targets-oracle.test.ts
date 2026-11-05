/**
 * `page-links.targets` as a lookup-only collection, on the TREE ORACLE
 * (tasks-core's `server/testing`): the real declaration compiled with the real
 * serve options (`./link-target-rows.ts`) against a throwaway database, its
 * materialized join (`page_link_targets`) installed through the boot path,
 * through the real feed.
 *
 * The workload is the link graph's own: root pages W, X, Y, Z, each with a
 * content block (W and X two), and edges X→W (from two blocks), Y→W, W→X and a self-link
 * W→W. Every step is one SQL transaction in the shape the reindexer or the
 * editor's writers emit (a trash or restore writes no edge).
 *
 * After every step:
 *
 * - the `:rows` point view (over W, X, Y) equals a fresh FULL load;
 * - it equals the old `page-links` loader (DISTINCT `(source, target)` over
 *   `page_links`) folded per live SOURCE page, self-links dropped (parity);
 * - its cost is exact: an edge write refills its source page's row alone, and
 *   only when the source's stored list changed (a second linking block of the
 *   same pair loads nothing); a keystroke's projection on a content block and
 *   a page rename load nothing; a trashed page reads not found (one load per
 *   route it trips); a trashed TARGET leaves the lists of the pages linking
 *   to it, and its restore brings it back, with no edge written either way.
 *
 * Then C39: a tab still running a bundle that subscribed an old key
 * (`page-links.sources`, the whole set this replaced, or the legacy
 * `page-links`) is refused `unknown-key`, a `skew` verdict (the Reload
 * prompt).
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
import { asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { installRollups } from "@plugins/database/plugins/derived-tables/server/testing";
import type { QueryDb } from "@plugins/network/plugins/live/plugins/query-resource/server";
import {
  compileCollection,
  subscribeAsOldDescriptor,
} from "@plugins/network/plugins/live/server/testing";
import {
  liveBlocks,
  PAGE_BLOCK_TYPE,
  pageLive,
} from "@plugins/page/plugins/editor/server";
import {
  createTreeOracle,
  type TreeLoad,
  type TreeOracle,
  type TreeStep,
} from "@plugins/tasks/plugins/tasks-core/server/testing";
import { pageLinkTargets } from "../../core/resources";
import {
  PageLinkTargetsRowSchema,
  type PageLinkTargetsRow,
} from "../../core/schemas";
import {
  linkTargetRowsServeOptions,
  pageLinkTargetsJoin,
} from "./link-target-rows";
import { _pageLinks } from "./tables";

setDefaultTimeout(120_000);

const ROWS_KEY = pageLinkTargets.rows.key;

/** Four root pages; `<page>-c` is a content block in each, `*-c2` a second one in W and X. */
const [W, X, Y, Z] = ["page-w", "page-x", "page-y", "page-z"] as const;
const content = (page: string) => `${page}-c`;
const X_C2 = "page-x-c2";
const W_C2 = "page-w-c2";
/** The ids the point reader holds. */
const WATCHED = [W, X, Y] as const;

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
 * The old `page-links` loader, verbatim (one row per page PAIR), folded per
 * SOURCE page — self-links and trashed targets dropped, targets in id order —
 * over the watched pages that are live.
 */
async function oldLoaderFolded(): Promise<PageLinkTargetsRow[]> {
  const edges = await oracle.db
    .selectDistinct({
      sourcePageId: _pageLinks.sourcePageId,
      targetPageId: _pageLinks.targetPageId,
    })
    .from(_pageLinks)
    .orderBy(asc(_pageLinks.sourcePageId), asc(_pageLinks.targetPageId));
  const pages = await oracle.db
    .select({ id: liveBlocks.id })
    .from(liveBlocks)
    .where(eq(liveBlocks.type, PAGE_BLOCK_TYPE))
    .orderBy(asc(liveBlocks.id));
  const live = new Set(pages.map((p) => p.id));
  const bySource = new Map<string, string[]>();
  for (const e of edges) {
    if (e.sourcePageId === e.targetPageId) continue;
    if (!live.has(e.targetPageId)) continue;
    const list = bySource.get(e.sourcePageId);
    if (list) list.push(e.targetPageId);
    else bySource.set(e.sourcePageId, [e.targetPageId]);
  }
  return pages
    .filter((p) => (WATCHED as readonly string[]).includes(p.id))
    .map((p) => ({ id: p.id, linksTo: bySource.get(p.id) ?? [] }));
}

const pointParams = () => pageLinkTargets.rows.point.encode([...WATCHED]);

async function expectParity(label: string): Promise<void> {
  const view = PageLinkTargetsRowSchema.array()
    .parse(oracle.view(ROWS_KEY, pointParams()))
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  expect({ step: label, rows: view }).toEqual({
    step: label,
    rows: await oldLoaderFolded(),
  });
}

async function runStep(step: TreeStep, rowLoads: TreeLoad[]): Promise<void> {
  const got = await oracle.run(step);
  await oracle.converged(step.label);
  await expectParity(step.label);
  expect({ step: step.label, rowLoads: got.loads[ROWS_KEY] ?? [] }).toEqual({
    step: step.label,
    rowLoads,
  });
}

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "page_link_targets_oracle",
    persisted: [],
  });
  // The materialized join, installed through the boot path (ON the feed:
  // readers are routed by its own rows), and the target liveness it nests.
  await installRollups(oracle.db, [pageLive, pageLinkTargetsJoin.rollup]);
  oracle.registerLookup(
    pageLinkTargets,
    compileCollection(pageLinkTargets, {
      ...linkTargetRowsServeOptions,
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
        contentRow(W_C2, W, "a1"),
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

describe("page-links.targets — a lookup-only collection on the tree oracle", () => {
  test("every step converges to a fresh FULL load at its exact cost, equal to the old loader", async () => {
    await oracle.subscribe(ROWS_KEY, pointParams());
    await oracle.converged("seed");
    await expectParity("seed");
    // One target per page pair (X links to W from two blocks), the self-link
    // dropped.
    expect(
      PageLinkTargetsRowSchema.array()
        .parse(oracle.view(ROWS_KEY, pointParams()))
        .sort((a, b) => (a.id < b.id ? -1 : 1)),
    ).toEqual([
      { id: W, linksTo: [X] },
      { id: X, linksTo: [W] },
      { id: Y, linksTo: [W] },
    ]);

    // A keystroke burst's `data.text` projection on a content block: the
    // route reads no column it writes, so nothing loads.
    await runStep(
      {
        label: "typing",
        statements: [
          `UPDATE page_blocks SET data = '{"text":[{"text":"typing…"}]}'::jsonb WHERE id = ${q(content(W))}`,
        ],
      },
      [],
    );

    // A rename writes the page row's `data`, which no field reads.
    await runStep(
      {
        label: "rename",
        statements: [
          `UPDATE page_blocks SET data = ${q(JSON.stringify({ title: "renamed", icon: null }))}::jsonb WHERE id = ${q(X)}`,
        ],
      },
      [],
    );

    // An edge insert (Y starts linking to X) refills its SOURCE Y alone.
    await runStep(
      { label: "edge.insert", statements: [edge(Y, X, content(Y))] },
      [{ ids: [Y] }],
    );

    // An edge from a page no reader holds: its stored list moves, nothing
    // loads here.
    await runStep(
      { label: "edge.insert.unwatched", statements: [edge(Z, W, content(Z))] },
      [],
    );

    // A second linking block of a pair already linked: the stored list is
    // unchanged, so nothing loads.
    await runStep(
      {
        label: "edge.insert.same-pair",
        statements: [edge(W, X, W_C2)],
      },
      [],
    );

    // An edge delete (Y stops linking to W), as the reindexer's diff emits it.
    await runStep(
      {
        label: "edge.delete",
        statements: [
          `DELETE FROM page_links WHERE source_page_id = ${q(Y)} AND target_page_id = ${q(W)}`,
        ],
      },
      [{ ids: [Y] }],
    );

    // One of X's two linking blocks drops its link: the pair survives, the
    // stored list is unchanged — nothing loads.
    await runStep(
      {
        label: "edge.delete.one-of-two",
        statements: [
          `DELETE FROM page_links WHERE source_block_id = ${q(X_C2)} AND target_page_id = ${q(W)}`,
        ],
      },
      [],
    );

    const edgeCount = async () =>
      (await oracle.db.select({ id: _pageLinks.sourcePageId }).from(_pageLinks))
        .length;
    const edgesBefore = await edgeCount();

    // Trash a TARGET (X, linked from W and Y): no edge is written, yet both
    // lists drop X — the nested `page_live` row's delete re-aggregates every
    // page linking to X. Loads: X itself (the base `where`'s flip), and W and
    // Y (their stored lists changed).
    await runStep(
      {
        label: "trash.target",
        statements: [
          `UPDATE page_blocks SET deleted_at = now(), trash_entry_id = 'te-x' WHERE id = ${q(X)}`,
        ],
      },
      [{ ids: [W, X, Y] }],
    );
    expect(await edgeCount()).toBe(edgesBefore);

    // Restore it: every alias comes back at once, with no reindex of W or Y.
    await runStep(
      {
        label: "restore.target",
        statements: [
          `UPDATE page_blocks SET deleted_at = NULL, trash_entry_id = NULL WHERE id = ${q(X)}`,
        ],
      },
      [{ ids: [W, X, Y] }],
    );
    expect(
      PageLinkTargetsRowSchema.array()
        .parse(oracle.view(ROWS_KEY, pointParams()))
        .find((r) => r.id === Y),
    ).toEqual({ id: Y, linksTo: [X] });

    // Trash a SOURCE (Y): it reads not found, and keeps its edges (its
    // content, restored with it).
    await runStep(
      {
        label: "trash.source",
        statements: [
          `UPDATE page_blocks SET deleted_at = now(), trash_entry_id = 'te-y' WHERE id = ${q(Y)}`,
        ],
      },
      [{ ids: [Y] }],
    );
    expect(
      (
        await oracle.db
          .select({ id: _pageLinks.sourcePageId })
          .from(_pageLinks)
          .where(inArray(_pageLinks.sourcePageId, [Y]))
      ).length,
    ).toBeGreaterThan(0);
    oracle.unsubscribe(ROWS_KEY, pointParams());
  });
});

describe("C39 — a tab on an old page-links resource", () => {
  for (const key of ["page-links.sources", "page-links"]) {
    test(`\`${key}\` is refused \`unknown-key\`, a \`skew\` verdict`, async () => {
      const old = await subscribeAsOldDescriptor(
        { key, schema: z.array(z.unknown()) },
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
