/**
 * Real-DB suite for the desktop queue's `jobs` answers (`graphileJobReads`):
 * **the SQL keyset cuts exactly where the served `$key` says.** A window's
 * `$key` is minted from `jobRunAtKeyText(runAt)` then the id; the SQL orders
 * and cuts on `(run_at` cut to ms`, id::text)`. If the two disagreed, a page
 * would skip or repeat rows — so this pages the whole queue THROUGH the served
 * half (which refuses an answer out of its key order or outside its cut),
 * every page cut at the previous page's minted `$key`, in both directions,
 * and holds every answer — windows at every cut, groupings, counts — to the
 * in-memory reference (`answerJobsInMemory`) over the same rows.
 *
 * The rows are made to collide where a keyset breaks: several `run_at`s that
 * differ only below the millisecond (one key instant, the id breaking the tie)
 * and ids on both sides of a digit boundary (`9` < `10` numerically, `"10"` <
 * `"9"` as text — the `$key` order).
 *
 * Runs against a throwaway database (`db-test-fixture`) with graphile's own
 * schema. Run: `./equin test plugins/infra/plugins/jobs`
 * (requires the running embedded cluster — `./equin build` first).
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { z } from "zod";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { createHarness } from "@plugins/framework/plugins/resource-runtime/core/testing";
import {
  serveCollectionOn,
  type LiveDecodedQuery,
  type LiveKeyDirection,
} from "@plugins/network/plugins/live/core";
import { jobRunAtKeyText, jobs, type JobRow } from "../../core/resources";
import {
  answerJobsInMemory,
  jobKeyOf,
} from "../../server/internal/jobs-window";
import { installQueueSchema } from "../../server/internal/queue-schema";
import { defineJob } from "../../server/internal/registry";
import { graphileJobReads } from "./jobs-list";

let t: TestDb;
let reads: ReturnType<typeof graphileJobReads>;
/** Every row the queue lists, as the SQL reads it. */
let all: JobRow[];

const job = defineJob({
  name: "jobs.jobs-list-test",
  description: "Test job.",
  hold: "instant",
  input: z.object({ n: z.number() }),
  event: z.never(),
  dedup: "none",
  run: () => {
    throw new Error(
      "[jobs] jobs-list-test job was dispatched; this suite starts no worker",
    );
  },
});

const COUNT = 24;

beforeAll(async () => {
  t = await createTestDb({ prefix: "jobs_list_test" });
  await installQueueSchema(t.connectionString);
  reads = graphileJobReads(t.db);
  for (let n = 0; n < COUNT; n++) {
    const { jobId } = await t.db.transaction((tx) =>
      job.enqueue({ n }, { tx }),
    );
    // Four instants, each shared by six rows — differing below the ms for
    // half of them, so the ms cut collides and the id breaks the tie. Some
    // rows retrying (attempts > 0), some dead, one with an error.
    const ms = n % 4;
    const us = n % 2 === 0 ? 0 : 400 + n;
    await t.db.execute(sql`
      UPDATE graphile_worker._private_jobs
         SET run_at = timestamptz '2026-03-01 00:00:00+00'
                      + ${ms} * interval '1 millisecond'
                      + ${us} * interval '1 microsecond',
             attempts = ${n % 5 === 0 ? 25 : n % 3},
             last_error = ${n % 7 === 0 ? `boom ${n}` : null}
       WHERE id = ${jobId}::bigint`);
  }
  all = [
    ...(await reads.window(
      windowQuery("desc", { limit: jobs.window.window.maxLimit }),
    )),
  ];
});

afterAll(async () => {
  await t.drop();
});

function windowQuery(
  dir: LiveKeyDirection,
  over: Partial<LiveDecodedQuery<"runAt">> = {},
): LiveDecodedQuery<"runAt"> {
  return {
    limit: 100,
    where: undefined,
    orderBy: [["runAt", dir]],
    ...over,
  };
}

const ids = (rows: readonly JobRow[]) => rows.map((r) => r.id);

describe("the keyset", () => {
  test("lists every row, and the instants collide below the ms", () => {
    expect(all).toHaveLength(COUNT);
    const instants = new Set(all.map((r) => jobRunAtKeyText(r.runAt)));
    expect(instants.size).toBe(4);
    // ids cross a digit boundary, so text order is not numeric order.
    expect(all.some((r) => r.id.length === 1)).toBe(true);
    expect(all.some((r) => r.id.length === 2)).toBe(true);
  });

  for (const dir of ["desc", "asc"] as const) {
    test(`windows at every cut match the reference (${dir})`, async () => {
      const ref = answerJobsInMemory(all);
      expect(ids(await reads.window(windowQuery(dir)))).toEqual(
        ids(ref.window(windowQuery(dir))),
      );
      for (const row of all) {
        const cut = jobKeyOf(row);
        for (const q of [
          windowQuery(dir, { after: cut, limit: 5 }),
          windowQuery(dir, { until: cut }),
        ]) {
          expect(ids(await reads.window(q))).toEqual(ids(ref.window(q)));
        }
      }
    });

    test(`paging through the served half covers the queue once (${dir})`, async () => {
      const h = createHarness();
      const served = serveCollectionOn(h.runtime, jobs, {
        source: "external",
        changes: "notified",
        ...reads,
        keyText: { runAt: jobRunAtKeyText },
      });
      const seen: string[] = [];
      let after: string | undefined;
      for (;;) {
        const page = (await served.window.load(
          jobs.window.window.encode(
            { orderBy: [["runAt", dir]], limit: 5 },
            after === undefined ? {} : { after },
          ),
        )) as (JobRow & { $key: string | null })[];
        seen.push(...ids(page));
        if (page.length < 5) break;
        after = page.at(-1)!.$key!;
      }
      expect(seen).toEqual(
        ids(answerJobsInMemory(all).window(windowQuery(dir))),
      );
    });
  }

  test("rows(ids) reads exactly the ids asked", async () => {
    const asked = [all[0]!.id, all[5]!.id, "999999"];
    expect(ids(await reads.rows(asked)).sort()).toEqual(
      [all[0]!.id, all[5]!.id].sort(),
    );
  });
});

describe("filters, groupings and counts", () => {
  const where = {
    or: [
      { column: "state", op: "in", operand: ["dead", "retrying"] },
      { column: "lastError", op: "isNotEmpty" },
    ],
  } as const;
  const decodedWhere = jobs.window.window.decode(
    jobs.window.window.encode({ where }),
  ).where;

  test("a filtered window matches the reference", async () => {
    const q = windowQuery("desc", { where: decodedWhere });
    const got = await reads.window(q);
    expect(got.length).toBeGreaterThan(0);
    expect(ids(got)).toEqual(ids(answerJobsInMemory(all).window(q)));
  });

  test("groupings and counts match the reference", async () => {
    const ref = answerJobsInMemory(all);
    for (const groupBy of ["state", "jobName", "hold", "attempts"] as const) {
      for (const w of [undefined, decodedWhere]) {
        const q = { groupBy, limit: 50, where: w };
        expect(await reads.groups(q)).toEqual(ref.groups(q));
      }
    }
    expect(await reads.count({ where: decodedWhere })).toBe(
      ref.count({ where: decodedWhere }),
    );
    expect(await reads.count({ where: undefined })).toBe(COUNT);
  });
});
