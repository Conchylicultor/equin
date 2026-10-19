/**
 * `serveCollection`'s `all` arm (P8 v3 step 16b.6, C4): a collection declared
 * `liveCollection(key, { all })` is bound like a window collection (fields by
 * name, overrides in `columns` — aggregates of a grouped join included — and a
 * base `where`) and compiled by query-resource's `compileAllCollection`. The
 * branch is taken BEFORE the lookup-only one (an `all` collection has no
 * window either), registers BOTH minted keys (A28's runtime half), and never
 * reaches the scoped path.
 *
 * The runtime behaviour over a real database (entrant, exit, order move,
 * value-only refill, the idle `{}` snapshot) is
 * `serve-collection-all-oracle.test.ts`; a scoped set's (`all: { by }`, one
 * tuple per scope) is `serve-collection-all-scoped-oracle.test.ts`.
 *
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { sql } from "drizzle-orm";
import { index, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import { z } from "zod";
import { fieldsToZodObject, nullable } from "@plugins/fields/core";
import { boolField } from "@plugins/fields/plugins/bool/plugins/config/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { jsonField } from "@plugins/fields/plugins/json/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { loadResourceByKey } from "@plugins/framework/plugins/server-core/core";
import { resourceDescriptorByKey } from "@plugins/primitives/plugins/live-state/core";
import {
  aggregate,
  childrenJoin,
  expr,
  jsonAgg,
  type ColumnRef,
} from "@plugins/infra/plugins/query-resource/core";
import {
  recordingQueryDb,
  type RecordedQuery,
} from "@plugins/infra/plugins/query-resource/server/testing";
import { entityRef } from "@plugins/infra/plugins/entities/core";
import { defineEntity } from "@plugins/infra/plugins/entities/server";
import { withWire } from "@plugins/database/plugins/sql-column/server";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { compileCollection, serveCollection } from "./serve-collection";
import type { ServedScopedColumns } from "./serve-columns";

const itemsRef = entityRef("sca_items", {
  id: textField({ label: "Id", filterable: false }),
  title: textField({ label: "Title", filterable: false }),
  rank: intField({ label: "Rank", filterable: false }),
  archived: boolField({ label: "Archived" }),
  note: nullable(textField({ label: "Note" })),
});
const items = defineEntity(itemsRef, { primaryKey: "id" });
const notes = pgTable(
  "sca_notes",
  {
    id: text("id").primaryKey(),
    itemId: text("item_id").notNull(),
    body: text("body").notNull(),
  },
  (t) => [index("sca_notes_item_idx").on(t.itemId)],
);

const ROW_FIELDS = {
  ...itemsRef.fields,
  notes: intField({ label: "Notes" }),
};
const Row = fieldsToZodObject(ROW_FIELDS);
type Row = z.infer<typeof Row>;

const ALL = {
  orderBy: [["rank", "asc"]],
  unbounded: { reason: "a test set" },
} as const;

let seq = 0;
const allCollection = (preload?: "boot") =>
  liveCollection(`test.live.all-${seq++}`, {
    from: itemsRef,
    pick: ["id", "title", "rank"],
    baseExposures: false,
    fields: { notes: ROW_FIELDS.notes },
    id: "id",
    all: ALL,
    ...(preload ? { preload } : {}),
  });

const notesJoin = childrenJoin({
  alias: "kids",
  table: notes,
  fk: notes.itemId,
  aggregates: (c) => ({
    count: aggregate(sql`count(${c.kids.id})::int`, {
      decoder: Number,
      sqlType: "integer",
      notNull: true,
      ifNone: sql`0`,
    }),
    longest: aggregate(sql`max(length(${c.kids.body}))`, {
      decoder: Number,
      sqlType: "integer",
    }),
  }),
});

/** Every key a collection minted, read off the descriptor registry (what `mintsOf` is checked against — A28). */
function mintedKeys(key: string): string[] {
  return ["", ":rows", ":groups"]
    .map((suffix) => key + suffix)
    .filter((k) => resourceDescriptorByKey(k) !== undefined);
}

async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

const sample = { id: "a", title: "T", rank: 1, notes: 2 };
const script = (q: RecordedQuery): unknown[] =>
  /^SELECT \S+ AS __id /.test(q.sql) ? [{ __id: "a" }] : [sample];

describe("serveCollection — the `all` arm (C4)", () => {
  test("registers BOTH minted keys, eagerly: the whole set and :rows, each loadable", async () => {
    const c = allCollection("boot");
    const { db, calls } = recordingQueryDb(script);
    const served = serveCollection(c, {
      from: items,
      joins: [notesJoin],
      columns: { notes: (j) => j.kids.count },
      where: (j) => sql`${j.base.archived} = false`,
      db,
    });
    expect(served.keys).toEqual([c.key, `${c.key}:rows`]);
    expect(served.all.key).toBe(c.key);
    expect(served.rows.key).toBe(`${c.key}:rows`);
    expect(served.declare).toHaveLength(2);
    // Loaded through the runtime the facade registered them in.
    expect(await loadResourceByKey(c.key, {})).toEqual([sample]);
    expect(await loadResourceByKey(`${c.key}:rows`, { ids: "a" })).toEqual([
      sample,
    ]);
    // The whole set's SQL: the grouped CTE, the base `where`, the order.
    const full = calls[0]!.sql;
    expect(full).toMatch(/^WITH __c_kids AS/);
    expect(full).toContain(`"sca_items"."archived" = false`);
    expect(full).toMatch(/ORDER BY "sca_items"."rank" ASC/);
  });

  test("A28 (runtime half): what serveCollection registers is exactly what the declaration minted — window, lookup-only and `all`", () => {
    const { db } = recordingQueryDb();
    const window = liveCollection(`test.live.all-window-${seq++}`, {
      from: itemsRef,
      pick: ["id", "title", "rank"],
      id: "id",
      sortable: ["rank"],
      default: { orderBy: [["rank", "asc"]], limit: 10 },
      maxLimit: 20,
    });
    const lookup = liveCollection(`test.live.all-lookup-${seq++}`, {
      from: itemsRef,
      carry: { pick: ["id", "title"] },
      id: "id",
    });
    const all = allCollection();
    const keysOf = (served: { keys: readonly string[] }): string[] => [
      ...served.keys,
    ];
    expect(keysOf(serveCollection(window, { from: items, db }))).toEqual(
      mintedKeys(window.key),
    );
    expect(keysOf(serveCollection(lookup, { from: items, db }))).toEqual(
      mintedKeys(lookup.key),
    );
    expect(
      keysOf(
        serveCollection(all, {
          from: items,
          joins: [notesJoin],
          columns: { notes: (j) => j.kids.count },
          db,
        }),
      ),
    ).toEqual(mintedKeys(all.key));
  });

  test("compileCollection derives the same two halves without registering; `throttleMs` is the whole set's debounce (C18)", async () => {
    const c = allCollection();
    const { db } = recordingQueryDb(script);
    const specs = compileCollection(c, {
      from: items,
      joins: [notesJoin],
      columns: { notes: (j) => j.kids.count },
      throttleMs: 250,
      db,
    });
    expect(specs.keyField).toBe("id");
    expect(specs.definition).toMatch(/^[0-9a-f]{64}$/);
    expect((specs.all as unknown as { debounceMs?: number }).debounceMs).toBe(
      250,
    );
    expect(
      (specs.rows as unknown as { debounceMs?: number }).debounceMs,
    ).toBeUndefined();
    expect(specs.all.scopedMembership).toBeDefined();
    // Nothing registered: neither key resolves on the server.
    expect((await rejection(loadResourceByKey(c.key, {}))).message).toMatch(
      /unknown resource key/,
    );
  });

  test("an expression over an aggregate binds like a column", async () => {
    const c = liveCollection(`test.live.all-expr-${seq++}`, {
      from: itemsRef,
      pick: ["id"],
      baseExposures: false,
      fields: { label: textField({ label: "Label" }) },
      id: "id",
      all: { orderBy: [["id", "asc"]], unbounded: { reason: "a test set" } },
    });
    const { db, calls } = recordingQueryDb(() => [{ id: "a", label: "T (2)" }]);
    const specs = compileCollection(c, {
      from: items,
      joins: [notesJoin],
      columns: {
        label: (j) =>
          expr(sql`${j.base.title} || ' (' || ${j.kids.count} || ')'`, {
            decoder: String,
            sqlType: "text",
            notNull: true,
          }),
      },
      db,
    });
    expect(await specs.all.loader({} as never)).toEqual([
      { id: "a", label: "T (2)" },
    ]);
    expect(calls[0]!.sql).toContain(`"sca_items"."title" || ' (' ||`);
  });

  test("refusals at module eval: a cast past the type, a nullable read on a non-null field, a wire form, a scoped set", () => {
    const { db } = recordingQueryDb();
    const c = allCollection();
    // A cast past `all?: never`'s twin: an `all` collection never scoped.
    expect(() =>
      serveCollection({ ...c, columnScope: "s" } as typeof c, {
        from: items,
        joins: [notesJoin],
        columns: { notes: (j) => j.kids.count },
        db,
      }),
    ).toThrow(/cannot be `columnScope`d/);
    // compileCollection's boot-time scoped sets never reach an `all` compile.
    const extra = {} as ServedScopedColumns;
    expect(() =>
      (
        compileCollection as unknown as (
          c: unknown,
          o: unknown,
          scoped: readonly ServedScopedColumns[],
        ) => unknown
      )(
        c,
        {
          from: items,
          joins: [notesJoin],
          columns: { notes: (j: { kids: { count: unknown } }) => j.kids.count },
          db,
        },
        [extra],
      ),
    ).toThrow(/scoped columns were served for a collection declared `all`/);
    // A nullable aggregate on a non-null field (the type's runtime backstop).
    expect(() =>
      compileCollection(c, {
        from: items,
        joins: [notesJoin],
        columns: {
          notes: ((j: { kids: { longest: unknown } }) =>
            j.kids.longest) as never,
        },
        db,
      }),
    ).toThrow(/row field "notes" may read NULL/);
    // A column ref `j` never offered (another table's column, through a cast).
    expect(() =>
      compileCollection(c, {
        from: items,
        joins: [notesJoin],
        columns: {
          notes: (() =>
            ({ from: "base", col: notes.body }) satisfies ColumnRef) as never,
        },
        db,
      }),
    ).toThrow(/not a wire column of that relation/);
    // A wire-encoded column: its encoder is code the L2 definition cannot read.
    const wired = pgTable("sca_wired", {
      id: text("id").primaryKey(),
      blob: withWire(text("blob").notNull(), {
        schema: z.string(),
        encode: (v: string) => v.toUpperCase(),
      }),
    });
    const w = liveCollection(`test.live.all-wire-${seq++}`, {
      fields: {
        id: textField({ label: "Id" }),
        blob: textField({ label: "Blob" }),
      },
      id: "id",
      all: { orderBy: [["id", "asc"]], unbounded: { reason: "a test set" } },
    });
    expect(() => compileCollection(w, { from: wired, db })).toThrow(
      /reads a wire-encoded value/,
    );
  });

  test("a collection declared by its own fields only is refused over a table", () => {
    const { db } = recordingQueryDb();
    const own = liveCollection(`test.live.all-own-${seq++}`, {
      fields: { id: textField({ label: "Id" }) },
      id: "id",
      all: { orderBy: [["id", "asc"]], unbounded: { reason: "a test set" } },
    });
    expect(() => serveCollection(own, { from: items, db })).toThrow(
      /declared by its own fields/,
    );
  });

  test("types: an aggregate's value type must be the field's, and a field that is no column needs `columns`", () => {
    // Never called — the assertions are the `@ts-expect-error`s.
    const _typesOnly = () => {
      const c = allCollection();
      // @ts-expect-error — `notes` is no column of `sca_items`, so `columns` is required
      serveCollection(c, { from: items, joins: [notesJoin] });
      // One line per refused overload call: past a failed overload,
      // TypeScript reports the call itself rather than the field at fault.
      // @ts-expect-error — `longest` is `number | null`, the field is `number`
      serveCollection(c, {
        from: items,
        joins: [notesJoin],
        columns: { notes: (j) => j.kids.longest },
      });
      serveCollection(c, {
        from: items,
        joins: [notesJoin],
        // @ts-expect-error — an aggregate of no declared join
        columns: { notes: (j) => j.other.count },
      });
      // A window or lookup collection's options cannot carry a grouped join.
      const lookup = liveCollection("t.all.lookup", {
        fields: { id: textField({ label: "Id" }) },
        id: "id",
      });
      // @ts-expect-error — a children join is the `all` compiler's alone (C9)
      serveCollection(lookup, { from: items, joins: [notesJoin] });

      // A field's JSON form (a `Date` as its ISO string) is admitted for a
      // `jsonAgg` only — the compiler renders its timestamps ISO-UTC. A
      // scalar aggregate's text form of a `timestamptz` is Postgres's, so it
      // must hold exactly the field's type.
      const stamps = pgTable("sca_stamps", {
        id: text("id").primaryKey(),
        itemId: text("item_id").notNull(),
        at: timestamp("at", { withTimezone: true }).notNull(),
      });
      const stampsJoin = childrenJoin({
        alias: "st",
        table: stamps,
        fk: stamps.itemId,
        aggregates: (c) => ({
          list: jsonAgg({ at: c.st.at }, { orderBy: [[c.st.at, "asc"]] }),
          lastText: aggregate(sql`max(${c.st.at})`, {
            decoder: String,
            sqlType: "timestamp with time zone",
            notNull: true,
            ifNone: sql`now()`,
          }),
        }),
      });
      const datedList = liveCollection("t.all.dated-list", {
        fields: { id: textField({ label: "Id" }) },
        carry: {
          fields: {
            stamps: jsonField({
              schema: z.array(z.object({ at: z.coerce.date() })),
              default: [],
            }),
          },
        },
        id: "id",
        all: { orderBy: [["id", "asc"]], unbounded: { reason: "a test set" } },
      });
      serveCollection(datedList, {
        from: items,
        joins: [stampsJoin],
        columns: { stamps: (j) => j.st.list },
      });
      const datedLast = liveCollection("t.all.dated-last", {
        fields: {
          id: textField({ label: "Id" }),
          last: dateField({ label: "Last" }),
        },
        id: "id",
        all: { orderBy: [["id", "asc"]], unbounded: { reason: "a test set" } },
      });
      // @ts-expect-error — a scalar aggregate's `string` is no proof of a `Date` field's ISO form
      serveCollection(datedLast, {
        from: items,
        joins: [stampsJoin],
        columns: { last: (j) => j.st.lastText },
      });
      const _row: Row | undefined = undefined;
      void _row;
    };
    void _typesOnly;
  });
});

describe("serveCollection — a scoped `all` (`all: { by }`)", () => {
  const blocksRef = entityRef("sca_blocks", {
    id: textField({ label: "Id", filterable: false }),
    pageId: textField({ label: "Page", filterable: false }),
    rank: intField({ label: "Rank", filterable: false }),
    title: textField({ label: "Title", filterable: false }),
    at: dateField({ label: "At", filterable: false }),
  });
  const blocks = defineEntity(blocksRef, { primaryKey: "id" });
  const scopedCollection = (by: readonly ("pageId" | "at" | "title")[]) =>
    liveCollection(`test.live.all-scoped-${seq++}`, {
      from: blocksRef,
      pick: ["id", "pageId", "rank", "title", "at"],
      baseExposures: false,
      id: "id",
      all: {
        by: by as readonly ["pageId"],
        orderBy: [["rank", "asc"]],
        unbounded: { reason: "one page's blocks" },
      },
    });
  const block = {
    id: "b1",
    pageId: "p1",
    rank: 1,
    title: "T",
    at: "2026-10-19 10:00:00+00",
  };
  const blockScript = (q: RecordedQuery): unknown[] =>
    /^SELECT \S+ AS __id /.test(q.sql) ? [{ __id: "b1" }] : [block];

  test("registers both keys; a tuple reads its scope, `:rows` reads by id alone", async () => {
    const c = scopedCollection(["pageId"]);
    const { db, calls } = recordingQueryDb(blockScript);
    const served = serveCollection(c, { from: blocks, db });
    expect(served.keys).toEqual([c.key, `${c.key}:rows`]);
    expect(served.declare).toHaveLength(2);
    await loadResourceByKey(c.key, { pageId: "p1" });
    expect(calls.at(-1)!.sql).toContain(`"sca_blocks"."page_id" = $`);
    expect(calls.at(-1)!.params).toContain("p1");
    await loadResourceByKey(`${c.key}:rows`, { ids: "b1" });
    expect(calls.at(-1)!.sql).not.toContain(`"sca_blocks"."page_id" = $`);
  });

  test("compileCollection: the server gate is the descriptor's (exactly the scope) and the route matches the scope column", () => {
    const c = scopedCollection(["pageId"]);
    const specs = compileCollection(c, {
      from: blocks,
      db: recordingQueryDb(blockScript).db,
    });
    const gate = (specs.all as { validateParams?: (p: object) => void })
      .validateParams!;
    expect(() => gate({ pageId: "p1" })).not.toThrow();
    expect(() => gate({})).toThrow(/param "pageId" must be a non-empty string/);
    expect(() => gate({ pageId: "p1", rank: "1" })).toThrow(
      /unknown param "rank"/,
    );
    const base = specs.all.routes!.routes.find((r) => r.id === "base")!;
    expect(base.match).toEqual(["page_id"]);
    expect(
      specs.all.routes!.usesOf({ pageId: "p1" }).get("base")!.match,
    ).toEqual({ page_id: new Set(["p1"]) });
  });

  test("refusals at module eval: a scope whose column type has no canonical text", () => {
    expect(() =>
      compileCollection(scopedCollection(["at"]), {
        from: blocks,
        db: recordingQueryDb(blockScript).db,
      }),
    ).toThrow(
      /the scope field "at" \(`all.by`\) is a timestamp with time zone column/,
    );
    // A text scope of another column is fine.
    expect(() =>
      compileCollection(scopedCollection(["title"]), {
        from: blocks,
        db: recordingQueryDb(blockScript).db,
      }),
    ).not.toThrow();
  });

  test("types: the served set's params are exactly the scope", () => {
    // Never called — the assertions are the `@ts-expect-error`s.
    const _typesOnly = () => {
      const served = serveCollection(scopedCollection(["pageId"]), {
        from: blocks,
      });
      void served.all.load({ pageId: "p1" });
      // @ts-expect-error — a scoped set has no `{}` tuple
      void served.all.load({});
      const whole = serveCollection(allCollection(), {
        from: items,
        joins: [notesJoin],
        columns: { notes: (j) => j.kids.count },
      });
      void whole.all.load({});
      // @ts-expect-error — the whole set takes no param
      void whole.all.load({ pageId: "p1" });
    };
    void _typesOnly;
  });
});
