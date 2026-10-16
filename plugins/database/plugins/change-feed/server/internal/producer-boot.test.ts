/**
 * The change feed's boot install (`installFeed` — the body of change-feed's
 * `onReadyBlocking`) with a PRODUCED table, on a throwaway database: the
 * denylist keeps the feed off it (and drops the triggers a previous boot left),
 * A1′ counts it as covered, and A2′ / A3p refuse the declarations that would
 * give it a second change source or a route it cannot serve. Run with
 * `./singularity test plugins/database/plugins/change-feed`.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { installFeed, type FeedInstallInputs } from "./install-feed";
import { assertNoTriggerOnProduced } from "./produced-tables";
import { readInstalledTriggers } from "./route-layout";

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "cf_producer_boot" });
  await t.db.execute(
    sql`CREATE TABLE pb_items (id text PRIMARY KEY, kind text NOT NULL)`,
  );
  await t.db.execute(sql`CREATE TABLE pb_other (id text PRIMARY KEY)`);
});

afterAll(async () => {
  await t?.drop();
});

const NONE = new Set<string>();

// The routed collection over the produced table: one identity route (its own
// PK, nothing carried), as the window compiler emits for a base table.
const identityLayout = {
  table: "pb_items",
  carry: [],
  reads: [["id", "kind"]],
};

function inputs(
  over: Partial<FeedInstallInputs["exclusions"]> = {},
  rest: Partial<Omit<FeedInstallInputs, "exclusions">> = {},
): FeedInstallInputs {
  return {
    exclusions: {
      feedExempt: NONE,
      optedOut: NONE,
      produced: new Set(["pb_items"]),
      ...over,
    },
    layouts: [identityLayout],
    scoped: [{ key: "items.list", table: "pb_items", via: 'route "items"' }],
    unfed: [],
    relations: { views: new Map(), rollups: new Map() },
    ...rest,
  };
}

async function triggeredTables(): Promise<string[]> {
  const rows = await readInstalledTriggers(t.db, ["pb_items", "pb_other"]);
  return [...new Set(rows.map((r) => r.table))].sort();
}

async function rejection(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return String(err);
  }
  throw new Error("expected the install to throw, but it resolved");
}

describe("installFeed with a produced table", () => {
  test("a table that was triggered loses its triggers once produced; A1′ covers a route on it", async () => {
    // A previous boot, before the table had a producer.
    await installFeed(t.db, inputs({ produced: NONE }));
    expect(await triggeredTables()).toEqual(["pb_items", "pb_other"]);

    // Produced now: no trigger survives, and the routed reader of the table is
    // covered (A1 alone would refuse it — the table has no trigger).
    await installFeed(t.db, inputs());
    expect(await triggeredTables()).toEqual(["pb_other"]);
    // A steady-state restart (the fast path) keeps it that way.
    await installFeed(t.db, inputs());
    expect(await triggeredTables()).toEqual(["pb_other"]);
  });

  test("A1′ still refuses a table with no change source at all", async () => {
    const err = await rejection(
      installFeed(
        t.db,
        inputs(
          {},
          {
            scoped: [
              { key: "ghost.list", table: "pb_ghost", via: 'route "ghost"' },
            ],
          },
        ),
      ),
    );
    expect(err).toContain("Dead scope policy");
    expect(err).toContain("pb_ghost");
  });

  test("A2′: a produced table that is also opted out, or a rollup, blocks boot", async () => {
    expect(
      await rejection(
        installFeed(t.db, inputs({ optedOut: new Set(["pb_items"]) })),
      ),
    ).toContain("AND an ExcludeFromChangeFeed");
    expect(
      await rejection(
        installFeed(t.db, inputs({ feedExempt: new Set(["pb_items"]) })),
      ),
    ).toContain("AND is a derived-table rollup");
  });

  test("D35: a view's bases must each have a change source or be opted out", async () => {
    // A view over a produced and a triggered table, and one over an opted-out
    // table: every base is sourced.
    await installFeed(
      t.db,
      inputs(
        { optedOut: new Set(["pb_quiet"]) },
        {
          relations: {
            views: new Map([
              ["pb_v", ["pb_items", "pb_other"]],
              ["pb_quiet_v", ["pb_quiet"]],
            ]),
            rollups: new Map(),
          },
        },
      ),
    );
    // A view reaching, through a rollup, a source no trigger feeds.
    const err = await rejection(
      installFeed(
        t.db,
        inputs(
          {},
          {
            relations: {
              views: new Map([["pb_v", ["pb_other", "pb_roll"]]]),
              rollups: new Map([["pb_roll", ["pb_ghost"]]]),
            },
          },
        ),
      ),
    );
    expect(err).toContain("D35");
    expect(err).toContain('view "pb_v" → "pb_ghost"');
    expect(err).toContain('rollup "pb_roll" → "pb_ghost"');
    expect(err).not.toContain('"pb_other"');
  });

  test("A3p: a route on a produced table that needs a carried column blocks boot", async () => {
    const err = await rejection(
      installFeed(
        t.db,
        inputs(
          {},
          {
            layouts: [{ ...identityLayout, carry: ["kind"] }],
          },
        ),
      ),
    );
    expect(err).toContain("A3p");
    expect(err).toContain('"pb_items" routes need "kind"');
  });

  test("A2′ (catalog): a live_state trigger on a produced table blocks boot", async () => {
    await t.db.execute(sql`
      CREATE FUNCTION pb_noop() RETURNS trigger AS $$ BEGIN RETURN NULL; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER live_state_pb_items_x AFTER INSERT ON pb_items
        FOR EACH STATEMENT EXECUTE FUNCTION pb_noop();
    `);
    try {
      expect(
        await rejection(assertNoTriggerOnProduced(t.db, new Set(["pb_items"]))),
      ).toContain("live_state_pb_items_x");
    } finally {
      await t.db.execute(
        sql`DROP TRIGGER live_state_pb_items_x ON pb_items; DROP FUNCTION pb_noop()`,
      );
    }
  });
});
