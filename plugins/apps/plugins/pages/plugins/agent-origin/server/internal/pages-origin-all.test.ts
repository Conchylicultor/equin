/**
 * `pages-origin.all` holds EVERY agent-created page's marker: the pages
 * sidebar's `origin` field reads the whole set, so a marked page past the old
 * window's `maxLimit` (500) must still be in it — read before as the user's
 * (Private, not Scratch). The real declaration, compiled with the served
 * binding against a throwaway database carrying the real schema, loads the
 * whole set FULL.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/apps/plugins/pages/plugins/agent-origin`.
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
import { agentPages } from "../../shared/resources";
import { pageBlocksOrigin } from "./tables";

setDefaultTimeout(120_000);

/** The old window's `maxLimit`, plus one. */
const COUNT = 501;
const LAST = `po-${COUNT}`;

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "pages_origin_all" });
  await runMigrations(t.db);
  await t.db.execute(sql`
    INSERT INTO page_blocks (id, page_id, parent_id, type, data, rank)
    SELECT 'po-' || g, NULL, NULL, 'page',
           jsonb_build_object('title', 'page ' || g, 'icon', NULL),
           'a' || lpad(g::text, 6, '0')
    FROM generate_series(1, ${COUNT}) g`);
  await t.db.insert(pageBlocksOrigin.table).values(
    Array.from({ length: COUNT }, (_, i) => ({
      blockId: `po-${i + 1}`,
      source: "e2e:pages-origin-all",
    })),
  );
});

afterAll(async () => {
  await t?.drop();
});

test("the whole set holds the marked page past the old window's maxLimit", async () => {
  const specs = compileCollection(agentPages, {
    from: pageBlocksOrigin,
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(COUNT);
  expect(rows.some((r) => r.blockId === LAST)).toBe(true);
});
