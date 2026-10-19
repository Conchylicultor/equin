/**
 * `pageBlocks` as a SCOPED `all` collection (`all: { by: ["pageId"] }`, track
 * item [12] §A of research/2026-10-19-global-live-compiled-narrowing.md), on
 * the TREE ORACLE (tasks-core's `server/testing`): the real declaration
 * compiled with the real serve options (`pageBlocksServeOptions`) against a
 * throwaway database, through the real feed, with the `page_blocks` derived
 * `updated_at` trigger installed as a backend installs it.
 *
 * Two pages are subscribed — W (a paragraph P, a toggle T holding Q) and X (a
 * paragraph Y) — plus a `:rows` tuple over Y, the shape `useBlockCrumb`
 * subscribes. After every step each view equals a fresh FULL load of its
 * tuple, and the step costs exactly what the scope promises:
 *
 * - the typing projection on P (a `data`-only write) is ONE one-row refill —
 *   W's — and nothing on X or the `:rows` tuple (the router matches the
 *   change's `page_id`, and the point route holds no P);
 * - an insert is one refill and one `orderOf`; a rank move one refill and one
 *   `orderOf`; a trash an exit (its one-id probe, no `orderOf`); a restore an
 *   entrant;
 * - a cross-page move is an exit for W and an entrant for X: one refill each,
 *   one `orderOf` (X's);
 * - nothing is ever loaded FULL after the subscribe.
 *
 * Then C39 (plan A.4): the key was RENAMED to `page-blocks.v2` because of
 * what an old tab would have done under the kept name. Its sub-ack would
 * have parsed — the old `z.array(BlockSchema)` reads the new rows (pinned
 * below on the new key, which serves exactly what the old one would) — but
 * the frames after it are keyed `delta`s, which the old bundle's non-keyed
 * read cannot apply (`web/__tests__/page-blocks-old-tab.test.ts`: the client
 * throws "no keyOf registered" and the page freezes with no Reload prompt).
 * Renamed, the old key is refused `unknown-key`, a `skew` verdict.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/page/plugins/editor`.
 */

import {
  afterAll,
  beforeAll,
  describe,
  expect,
  setDefaultTimeout,
  test,
} from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  installDerivedUpdatedAt,
  registeredDerivedUpdatedAt,
} from "@plugins/database/plugins/derived-updated-at/server";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import {
  compileCollection,
  subscribeAsOldDescriptor,
} from "@plugins/network/plugins/live/server/testing";
import {
  createTreeOracle,
  type TreeLoad,
  type TreeOracle,
  type TreeStep,
} from "@plugins/tasks/plugins/tasks-core/server/testing";
import { pageBlocks } from "../../core/resources";
import { BlockSchema } from "../../core/schemas";
import { pageBlocksServeOptions } from "./resources";

setDefaultTimeout(120_000);

const KEY = pageBlocks.key;
const ROWS_KEY = pageBlocks.rows.key;
/** The key the forest had as a param'd value, before the rename. */
const OLD_KEY = "page-blocks";

/** The content block type the seed rows carry (any string: the set reads no type). */
const PARA = "page-blocks-para";
const TOGGLE = "page-blocks-toggle";

/** W holds P, then a toggle T holding Q; X holds Y. */
const [W, X, P, T, Q, Y, N] = [
  "page-w",
  "page-x",
  "para-p",
  "toggle-t",
  "para-q",
  "para-y",
  "para-n",
] as const;
const ON_W = { pageId: W };
const ON_X = { pageId: X };

let oracle: TreeOracle;

/**
 * One seed row, as plain SQL before the feed starts: the scoped set reads no
 * writer-derived column (`doc_rank`), so the seed need not go through the
 * structural-write chokepoint.
 */
function seedRow(args: {
  id: string;
  parentId: string | null;
  pageId: string | null;
  type: string;
  rank: string;
}): string {
  const data =
    args.type === "page"
      ? JSON.stringify({ title: args.id, icon: null })
      : JSON.stringify({ text: [{ text: args.id }] });
  const lit = (v: string | null) => (v === null ? "NULL" : `'${v}'`);
  return `INSERT INTO page_blocks (id, page_id, parent_id, type, data, rank, expanded)
          VALUES ('${args.id}', ${lit(args.pageId)}, ${lit(args.parentId)}, '${args.type}', '${data}'::jsonb, '${args.rank}', true)`;
}

/** The ids a page's view holds, in the set's order. */
function viewIds(params: Record<string, string>): string[] {
  return BlockSchema.array()
    .parse(oracle.view(KEY, params))
    .map((b) => b.id);
}

/** Loads in a fixed order, so two tuples' loads compare whatever order they drained in. */
function sortedLoads(loads: readonly TreeLoad[]): TreeLoad[] {
  return [...loads].sort((a, b) =>
    JSON.stringify(a.ids) < JSON.stringify(b.ids) ? -1 : 1,
  );
}

/** What a step must cost: the scoped set's loads (both pages') and `orderOf` calls, and the `:rows` tuple's loads. */
interface StepCost {
  loads: TreeLoad[];
  orderOf: number;
  rowLoads: TreeLoad[];
}

async function runSql(step: TreeStep, cost: StepCost): Promise<void> {
  const got = await oracle.run(step);
  await oracle.converged(step.label);
  expect({
    step: step.label,
    loads: sortedLoads(got.loads[KEY] ?? []),
    orderOf: got.orderOf[KEY] ?? 0,
    rowLoads: sortedLoads(got.loads[ROWS_KEY] ?? []),
  }).toEqual({
    step: step.label,
    loads: sortedLoads(cost.loads),
    orderOf: cost.orderOf,
    rowLoads: sortedLoads(cost.rowLoads),
  });
}

const textPayload = (text: string) =>
  JSON.stringify({ text: [{ text }] }).replace(/'/g, "''");

beforeAll(async () => {
  oracle = await createTreeOracle({
    prefix: "page_blocks_oracle",
    persisted: [],
  });
  // The derived `updated_at` trigger, as a backend installs it at boot: a
  // content write moves the row's `updatedAt` in the same statement.
  await installDerivedUpdatedAt(
    oracle.db,
    registeredDerivedUpdatedAt().filter((spec) => spec.table === "page_blocks"),
  );
  oracle.registerAll(
    pageBlocks,
    compileCollection(pageBlocks, {
      ...pageBlocksServeOptions,
      db: oracle.queryDb as unknown as QueryDb,
    }),
  );
  for (const row of [
    { id: W, parentId: null, pageId: null, type: "page", rank: "a0" },
    { id: X, parentId: null, pageId: null, type: "page", rank: "a1" },
    { id: P, parentId: W, pageId: W, type: PARA, rank: "a0" },
    { id: T, parentId: W, pageId: W, type: TOGGLE, rank: "a1" },
    { id: Q, parentId: T, pageId: W, type: PARA, rank: "a0" },
    { id: Y, parentId: X, pageId: X, type: PARA, rank: "a0" },
  ]) {
    await oracle.db.execute(sql.raw(seedRow(row)));
  }
  await oracle.start();
});

afterAll(async () => {
  await oracle?.stop();
});

describe("page-blocks — a scoped `all` collection on the tree oracle", () => {
  test("the route carries the scope: `page_id` is a key of every page_blocks change", () => {
    const req = oracle.runtime
      .routedTableRequirements()
      .find((r) => r.table === "page_blocks");
    expect(req?.carry).toContain("page_id");
  });

  test("every step converges to a fresh FULL load of each page at its exact cost; nothing loads FULL", async () => {
    await oracle.subscribe(KEY, ON_W);
    await oracle.subscribe(KEY, ON_X);
    const yRows = pageBlocks.rows.point.encode([Y]);
    await oracle.subscribe(ROWS_KEY, yRows);
    await oracle.converged("seed");
    expect(viewIds(ON_W)).toEqual([P, Q, T]);
    expect(viewIds(ON_X)).toEqual([Y]);
    const baseline = oracle.loadsOf(KEY).length;

    // The ~1s typing projection on P: W's one-row refill; X and the Y point
    // tuple load nothing.
    await runSql(
      {
        label: "typing",
        statements: [
          `UPDATE page_blocks SET data = '${textPayload("typing…")}'::jsonb WHERE id = '${P}'`,
        ],
      },
      { loads: [{ ids: [P] }], orderOf: 0, rowLoads: [] },
    );
    // A new block on W: one refill, one `orderOf`.
    await runSql(
      {
        label: "insert",
        statements: [
          `INSERT INTO page_blocks (id, page_id, parent_id, type, data, rank, expanded)
           VALUES ('${N}', '${W}', '${W}', '${PARA}', '${textPayload(N)}'::jsonb, 'a2', true)`,
        ],
      },
      { loads: [{ ids: [N] }], orderOf: 1, rowLoads: [] },
    );
    // A rank move inside W: one refill, one `orderOf`.
    await runSql(
      {
        label: "rank move",
        statements: [`UPDATE page_blocks SET rank = 'a3' WHERE id = '${P}'`],
      },
      { loads: [{ ids: [P] }], orderOf: 1, rowLoads: [] },
    );
    expect(viewIds(ON_W)).toEqual([Q, T, N, P]);
    // A trash is a where-flip exit; a restore an entrant.
    await runSql(
      {
        label: "trash",
        statements: [
          `UPDATE page_blocks SET deleted_at = now(), trash_entry_id = 'trash-n' WHERE id = '${N}'`,
        ],
      },
      { loads: [{ ids: [N] }], orderOf: 0, rowLoads: [] },
    );
    expect(viewIds(ON_W)).not.toContain(N);
    await runSql(
      {
        label: "restore",
        statements: [
          `UPDATE page_blocks SET deleted_at = NULL, trash_entry_id = NULL WHERE id = '${N}'`,
        ],
      },
      { loads: [{ ids: [N] }], orderOf: 1, rowLoads: [] },
    );
    // A cross-page move: Q leaves W and enters X — both scopes are keys of the
    // change, one refill each, X's `orderOf`.
    await runSql(
      {
        label: "cross-page move",
        statements: [
          `UPDATE page_blocks SET page_id = '${X}', parent_id = '${X}', rank = 'a1' WHERE id = '${Q}'`,
        ],
      },
      { loads: [{ ids: [Q] }, { ids: [Q] }], orderOf: 1, rowLoads: [] },
    );
    expect(viewIds(ON_W)).toEqual([T, N, P]);
    expect(viewIds(ON_X)).toEqual([Y, Q]);
    // A write to Y — X's block, the point tuple's row — refills both readers
    // of it and nothing on W.
    await runSql(
      {
        label: "typing on X",
        statements: [
          `UPDATE page_blocks SET data = '${textPayload("y!")}'::jsonb WHERE id = '${Y}'`,
        ],
      },
      { loads: [{ ids: [Y] }], orderOf: 0, rowLoads: [{ ids: [Y] }] },
    );
    expect(
      oracle
        .loadsOf(KEY)
        .slice(baseline)
        .some((l) => l.ids === "FULL"),
    ).toBe(false);
  });
});

describe("C39 — a tab on the old `page-blocks` value", () => {
  test("is refused `unknown-key`, a `skew` verdict (the Reload prompt)", async () => {
    const old = await subscribeAsOldDescriptor(
      { key: OLD_KEY, schema: z.array(BlockSchema) },
      { params: ON_W, handler: oracle.runtime.notificationsWsHandler },
    );
    expect(old).toEqual({
      kind: "refused",
      reason: "unknown-key",
      verdict: "skew",
    });
  });

  test("why the key was renamed: under the kept name its sub-ack would parse, and the next frame is a keyed `delta`", async () => {
    // The same params gate and value the old key would have served: the old
    // schema parses the sub-ack (the wire rows are `Block`s field for field)…
    const asOld = await subscribeAsOldDescriptor(
      { key: KEY, schema: z.array(BlockSchema) },
      { params: ON_W, handler: oracle.runtime.notificationsWsHandler },
    );
    expect(asOld.kind).toBe("parsed");
    // …and a write then reaches the tuple as a keyed `delta` frame, which the
    // old bundle's non-keyed read throws on (see the file header).
    const frames: { kind: string; key?: string }[] = [];
    const handler = oracle.runtime.notificationsWsHandler as unknown as {
      open(ws: unknown): void;
      message(ws: unknown, raw: string): void;
      close(ws: unknown, code: number, reason: string): void;
    };
    const ws = {
      send(raw: string) {
        const frame = JSON.parse(raw) as { kind: string; key?: string };
        if (frame.key === KEY) frames.push(frame);
      },
    };
    handler.open(ws);
    try {
      handler.message(
        ws,
        JSON.stringify({ op: "sub", key: KEY, params: ON_W }),
      );
      const deadline = Date.now() + 8000;
      while (!frames.some((f) => f.kind === "sub-ack")) {
        if (Date.now() > deadline) throw new Error("no sub-ack");
        await new Promise((r) => setTimeout(r, 5));
      }
      await oracle.run({
        label: "c39.write",
        statements: [
          `UPDATE page_blocks SET data = '${textPayload("c39")}'::jsonb WHERE id = '${T}'`,
        ],
      });
      expect(frames.map((f) => f.kind)).toEqual(["sub-ack", "delta"]);
    } finally {
      handler.close(ws, 1000, "c39");
    }
  });
});
