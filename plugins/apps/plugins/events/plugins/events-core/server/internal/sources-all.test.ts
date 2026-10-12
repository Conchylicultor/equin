/**
 * `events.sources.all` holds EVERY configured source: the Sources list and
 * the events list's Source field each read the whole set, so a source past the
 * old window's `maxLimit` (500; the Sources list read only its default 100)
 * must still be in it. The real declaration, compiled with the served binding
 * against a throwaway database carrying the real schema, loads the whole set
 * FULL, newest first.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/apps/plugins/events/plugins/events-core`.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { eventSourceIdKind, eventSources } from "../../core";
import { _eventSources } from "./tables";

setDefaultTimeout(120_000);

/** The old window's `maxLimit`, plus one. */
const COUNT = 501;
/** Every source's id, oldest first. */
const ids = Array.from({ length: COUNT }, () => eventSourceIdKind.mint());

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "event_sources_all" });
  await runMigrations(t.db);
  const base = Date.now() - COUNT * 1000;
  await t.db.insert(_eventSources).values(
    ids.map((id, i) => ({
      id,
      type: "manual",
      name: `source ${i + 1}`,
      config: {},
      refresh: "manual" as const,
      enabled: true,
      status: "idle" as const,
      createdAt: new Date(base + i * 1000),
    })),
  );
});

afterAll(async () => {
  await t?.drop();
});

test("the whole set holds the oldest source, past the old window's maxLimit", async () => {
  const specs = compileCollection(eventSources, {
    from: _eventSources,
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(COUNT);
  // Newest first: the oldest source — the one a window would drop — is last.
  expect(rows.at(-1)?.id).toBe(ids[0]);
});
