/**
 * A collection's declared `membership` (core, a `Filter` both runtimes read)
 * is rendered by `serveCollection` with the filter language's `filterSql`
 * over the base table's columns, ANDed with the serve call's `where` — on the
 * `all` arm and the window arm (whose `:rows` point read carries it too).
 *
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { loadResourceByKey } from "@plugins/framework/plugins/server-core/core";
import {
  recordingQueryDb,
  type RecordedQuery,
} from "@plugins/infra/plugins/query-resource/server/testing";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { compileCollection, serveCollection } from "./serve-collection";

const itemsRef = entityRef("scm_items", {
  id: textField({ label: "Id", filterable: false }),
  rank: intField({ label: "Rank", filterable: false }),
  archived: boolField({ label: "Archived" }),
  kind: textField({ label: "Kind" }),
  note: nullable(textField({ label: "Note" })),
});
const items = defineEntity(itemsRef, { primaryKey: "id" });

const MEMBERSHIP = {
  and: [
    { column: "archived", op: "eq", operand: false },
    { column: "kind", op: "ne", operand: "system" },
  ],
} as const;

let seq = 0;
const allCollection = () =>
  liveCollection(`test.live.membership-all-${seq++}`, {
    from: itemsRef,
    pick: ["id", "rank", "archived", "kind"],
    baseExposures: false,
    id: "id",
    membership: MEMBERSHIP,
    all: { orderBy: [["rank", "asc"]], unbounded: { reason: "a test set" } },
  });

const sample = { id: "a", rank: 1, archived: false, kind: "user" };
const script = (q: RecordedQuery): unknown[] =>
  /^SELECT \S+ AS __id /.test(q.sql) ? [{ __id: "a" }] : [sample];

describe("serveCollection — a declared `membership`", () => {
  test("the descriptor carries it canonical, with its filterable declaration", () => {
    const c = allCollection();
    expect(c.membership?.filter).toEqual({
      and: [
        { column: "archived", op: "eq", operand: false },
        { column: "kind", op: "ne", operand: "system" },
      ],
    });
    expect(c.membership?.filterable.kind).toEqual({ domain: "text" });
  });

  test("the `all` arm renders it, ANDed with the serve call's `where`", async () => {
    const c = allCollection();
    const { db, calls } = recordingQueryDb(script);
    serveCollection(c, {
      from: items,
      where: (j) => sql`${j.base.rank} > 0`,
      db,
    });
    expect(await loadResourceByKey(c.key, {})).toEqual([sample]);
    const full = calls[0]!.sql;
    expect(full).toContain(`"scm_items"."rank" > 0`);
    expect(full).toContain(`"scm_items"."archived"`);
    expect(full).toContain(`"scm_items"."kind"`);
    expect(full).toContain("IS NOT TRUE");
    expect(calls[0]!.params).toContain("system");
  });

  test("the window arm renders it into the window and the :rows point read", async () => {
    const c = liveCollection(`test.live.membership-window-${seq++}`, {
      from: itemsRef,
      pick: ["id", "rank", "archived", "kind"],
      baseExposures: false,
      id: "id",
      membership: MEMBERSHIP,
      sortable: ["rank"],
      default: { orderBy: [["rank", "asc"]], limit: 10 },
      maxLimit: 20,
    });
    const { db, calls } = recordingQueryDb(script);
    serveCollection(c, { from: items, db });
    await loadResourceByKey(`${c.key}:rows`, { ids: "a" });
    expect(calls.at(-1)!.sql).toContain(`"scm_items"."kind"`);
    expect(calls.at(-1)!.params).toContain("system");
  });

  test("a membership column bound through `columns` is refused", () => {
    const c = allCollection();
    expect(() =>
      compileCollection(c, {
        from: items,
        columns: { kind: (j) => j.base.note },
      }),
    ).toThrow(/membership.*reads "kind".*binds through `columns`/);
  });
});

describe("liveCollection — `membership`", () => {
  test("a column the collection cannot filter by is refused", () => {
    expect(() =>
      liveCollection(`test.live.membership-bad-${seq++}`, {
        from: itemsRef,
        pick: ["id", "rank", "kind"],
        baseExposures: false,
        id: "id",
        // @ts-expect-error — `rank` is not filterable (`filterable: false`)
        membership: { column: "rank", op: "eq", operand: 1 },
        all: { orderBy: [["rank", "asc"]], unbounded: { reason: "t" } },
      }),
    ).toThrow();
  });

  test("a membership matching every row is refused", () => {
    expect(() =>
      liveCollection(`test.live.membership-empty-${seq++}`, {
        from: itemsRef,
        pick: ["id", "rank", "kind"],
        baseExposures: false,
        id: "id",
        membership: { and: [] },
        all: { orderBy: [["rank", "asc"]], unbounded: { reason: "t" } },
      }),
    ).toThrow(/matches every row/);
  });
});
