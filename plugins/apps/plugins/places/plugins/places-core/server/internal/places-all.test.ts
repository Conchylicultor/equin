/**
 * `places.places.all` and `places.tags.all` hold EVERY saved place and EVERY
 * tag: the map draws every pin and the tag sidebar walks the whole tree, so a
 * place or tag past the old windows' `maxLimit` (5000) must still be in them —
 * a place the old window dropped was a missing pin, a tag a cut child. The
 * real declarations, compiled with the served bindings against a throwaway
 * database carrying the real schema, load each whole set FULL, in its order.
 *
 * Requires a running Postgres cluster (started by ./singularity build).
 * Run: `./singularity test plugins/apps/plugins/places`.
 */

import { afterAll, beforeAll, expect, setDefaultTimeout, test } from "bun:test";
import { count } from "drizzle-orm";
import {
  createTestDb,
  type TestDb,
} from "@plugins/database/plugins/db-test-fixture/server/testing";
import { runMigrations } from "@plugins/database/plugins/migrations/server/testing";
import type { QueryDb } from "@plugins/infra/plugins/query-resource/server";
import { compileCollection } from "@plugins/network/plugins/live/server/testing";
import { placeIdKind, places, placeTagIdKind, placeTags } from "../../core";
import { _places, _placeTags } from "./tables";

setDefaultTimeout(120_000);

/** The old windows' `maxLimit`, plus one. */
const COUNT = 5001;
/** Every place's id, oldest first. */
const placeIds = Array.from({ length: COUNT }, () => placeIdKind.mint());
/** Every tag's id, by ascending rank. */
const tagIds = Array.from({ length: COUNT }, () => placeTagIdKind.mint());

let t: TestDb;

beforeAll(async () => {
  t = await createTestDb({ prefix: "places_all" });
  await runMigrations(t.db);
  const base = Date.now() - COUNT * 1000;
  await t.db.insert(_places).values(
    placeIds.map((id, i) => ({
      id,
      googlePlaceId: `g-${i}`,
      name: `place ${i + 1}`,
      address: "",
      location: { lat: 0, lng: 0 },
      createdAt: new Date(base + i * 1000),
    })),
  );
  await t.db.insert(_placeTags).values(
    tagIds.map((id, i) => ({
      id,
      name: `tag ${i + 1}`,
      parentId: i === COUNT - 1 ? tagIds[0] : null,
      rank: i,
    })),
  );
});

afterAll(async () => {
  await t?.drop();
});

async function rowCount(
  table: typeof _places | typeof _placeTags,
): Promise<number> {
  const [row] = await t.db.select({ n: count() }).from(table);
  if (row === undefined) throw new Error("count(*) returned no row");
  return row.n;
}

test("the whole place set holds the oldest place, past the old window's maxLimit", async () => {
  const specs = compileCollection(places, {
    from: _places,
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(await rowCount(_places));
  expect(rows.length).toBeGreaterThanOrEqual(COUNT);
  // Newest first: the oldest place — the one a window would drop — is last.
  expect(rows.at(-1)?.id).toBe(placeIds[0]);
});

test("the whole tag tree holds the last-ranked tag, past the old window's maxLimit", async () => {
  const specs = compileCollection(placeTags, {
    from: _placeTags,
    db: t.db as unknown as QueryDb,
  });
  const rows = await specs.all.loader({});
  expect(rows).toHaveLength(await rowCount(_placeTags));
  // Rank order: the last-ranked tag — a child a window would orphan — is last.
  expect(rows.at(-1)).toMatchObject({ id: tagIds.at(-1), parentId: tagIds[0] });
});
