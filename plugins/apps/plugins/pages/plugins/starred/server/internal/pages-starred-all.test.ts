/**
 * `pages-starred.all` holds EVERY favorite: the pages sidebar's `starred`
 * field reads the whole set, so a favorite past the old window's `maxLimit`
 * (1000) must still be in it — read before as unstarred. The real declaration,
 * compiled with the served binding against a throwaway database carrying the
 * real schema, loads the whole set FULL.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/apps/plugins/pages/plugins/starred`.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { starredPages } from "../../shared/resources";
import { pageBlocksStarred } from "./tables";

setDefaultTimeout(120_000);

/** The old window's `maxLimit`, plus one. */
const COUNT = 1001;
const LAST = `ps-${COUNT}`;

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "pages_starred_all" });
  await runMigrations(t.db);
  await t.db.execute(sql`
    INSERT INTO page_blocks (id, page_id, parent_id, type, data, rank)
    SELECT 'ps-' || g, NULL, NULL, 'page',
           jsonb_build_object('title', 'page ' || g, 'icon', NULL),
           'a' || lpad(g::text, 6, '0')
    FROM generate_series(1, ${COUNT}) g`);
  await t.db
    .insert(pageBlocksStarred.table)
    .values(
      Array.from({ length: COUNT }, (_, i) => ({ blockId: `ps-${i + 1}` })),
    );
});

afterAll(async () => {
  await t?.drop();
});

test("the whole set holds the favorite past the old window's maxLimit", async () => {
  const specs = compileCollection(starredPages, {
    from: pageBlocksStarred,
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(COUNT);
  expect(rows.some((r) => r.blockId === LAST)).toBe(true);
});
