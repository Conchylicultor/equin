/**
 * `serveCollection` over a SCOPED column set (P3 of
 * research/2026-09-29-global-scoped-change-routing.md — a DataView surface's
 * custom columns), without a database: the recording `QueryDb` renders every
 * query, so each case reads the SQL a tuple runs.
 *
 * - one route for the whole set (an alias on the host key, kept to the scope's
 *   rows, matched per tuple on the members it reads);
 * - a tuple joins exactly the members its where / order names, as membership;
 * - a member's value reads through its type's cast, looked up at load time;
 * - a member a tuple ORDERS BY is projected and folded under `$scoped`, where
 *   the order signature reads it;
 * - the scope's `recomputeOn` reaches the window's server options;
 * - provenance: every shape joins exactly the members `usesOf` names.
 *
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { familyMemberAlias } from "@plugins/infra/plugins/query-resource/core/testing";
import {
  compileWindowQuery,
  recordingQueryDb,
} from "@plugins/infra/plugins/query-resource/server/testing";
import {
  liveCollection,
  scopedLiveColumns,
  type LiveColumnsDeclaration,
  type LiveWindowParams,
} from "@plugins/network/plugins/live/core";
import {
  liveNumber,
  liveText,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { compileCollection } from "./serve-collection";
import { serveScopedColumns, type ScopedMemberRead } from "./serve-columns";

const songs = pgTable("sc_songs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  n: integer("n").notNull(),
});
const values = pgTable(
  "sc_custom_values",
  {
    dataViewId: text("data_view_id").notNull(),
    rowKey: text("row_key").notNull(),
    columnId: text("column_id").notNull(),
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.dataViewId, t.rowKey, t.columnId] })],
);

const SCOPE = "test.surface";
const RECOMPUTE = { resource: { key: "test.defs" } as never, params: {} };

let seq = 0;
function setup() {
  const members = new Map<string, ScopedMemberRead>([
    ["c1", { domain: "text" }],
    [
      "cc-2",
      {
        domain: "number",
        cast: { sql: (raw) => sql`(${raw})::numeric`, sqlType: "numeric" },
      },
    ],
  ]);
  const set = serveScopedColumns({
    name: "custom",
    table: values,
    scope: values.dataViewId,
    hostKey: values.rowKey,
    member: values.columnId,
    value: values.value,
    members: () => members,
    recomputeOn: () => RECOMPUTE,
  });
  const c = liveCollection(`test.live.scoped-${seq++}`, {
    row: z.object({ id: z.string(), title: z.string(), n: z.number() }),
    id: "id",
    filterable: { title: liveText(), n: liveNumber() },
    sortable: ["title", "n"],
    default: { orderBy: [["n", "asc"]], limit: 10 },
    maxLimit: 50,
    columnScope: SCOPE,
  });
  const recording = recordingQueryDb((q) =>
    // A window read answers one row carrying the member it orders by.
    q.sql.includes("__family_")
      ? [
          {
            id: "a",
            title: "A",
            n: 1,
            __family_0: "x",
            __row_key_0: "x",
            __row_key_1: "a",
          },
        ]
      : [],
  );
  const specs = compileCollection(
    c,
    { from: songs, db: recording.db },
    [],
    [set],
  );
  const window = compileWindowQuery(c.window, specs.window).serverOpts;
  // What the browser hands the codec: the members as it knows them.
  const handle: LiveColumnsDeclaration = scopedLiveColumns(SCOPE, "custom", {
    c1: { domain: "text", sortable: true },
    "cc-2": { domain: "number", sortable: true },
  });
  // A query naming members by wire name (`custom.<id>`), which the
  // collection's own column types cannot spell.
  const encode = (q: {
    where?: object;
    orderBy?: readonly (readonly [string, "asc" | "desc"])[];
  }) => c.window.window.encode({ ...q, columns: [handle] } as never);
  return { c, set, members, window, encode, ...recording };
}

const usesOf = (
  window: ReturnType<typeof setup>["window"],
  params: LiveWindowParams,
) =>
  Object.fromEntries(
    [...window.routes!.usesOf(params)].map(([id, u]) => [
      id,
      u.match === undefined
        ? u.role
        : [
            u.role,
            Object.fromEntries(
              Object.entries(u.match).map(([k, v]) => [k, [...v].sort()]),
            ),
          ],
    ]),
  );

describe("serveCollection with a scoped column set", () => {
  test("a member's join alias is injective over its id", () => {
    expect(familyMemberAlias("custom", "cc-2")).toBe("custom__cc_2d_2");
    expect(familyMemberAlias("custom", "cc_2")).toBe("custom__cc_5f_2");
  });

  test("a member alias never crosses Postgres's 63-byte identifier limit, whatever the id", () => {
    const uuid = "cc-0f8fad5b-d9cb-469f-a165-70867728950e";
    // The real id format fits spelled out (62 bytes).
    expect(familyMemberAlias("custom", uuid)).toBe(
      "custom__cc_2d_0f8fad5b_2d_d9cb_2d_469f_2d_a165_2d_70867728950e",
    );
    // A longer family name or id is hashed — within the limit, distinct per
    // member, and in a form no spelled alias can take (`___h`).
    const long = familyMemberAlias("custom_set", uuid);
    const other = familyMemberAlias("custom_set", `${uuid}x`);
    for (const a of [long, other]) {
      expect(a.length).toBeLessThanOrEqual(63);
      expect(a.startsWith("custom_set___h")).toBe(true);
    }
    expect(long).not.toBe(other);
    expect(familyMemberAlias("custom_set", uuid)).toBe(long);
  });

  test("one route for the whole set: an alias on the host key, kept to the scope, matched on the member", () => {
    const { window } = setup();
    expect(window.routes!.routes.find((r) => r.id === "custom")).toEqual({
      id: "custom",
      table: "sc_custom_values",
      map: { kind: "alias", column: "row_key" },
      rows: { data_view_id: SCOPE },
      match: ["column_id"],
      columns: ["data_view_id", "row_key", "column_id", "value"],
    });
  });

  test("a tuple reads the set only when its where / order names a member — as membership, matching exactly those members", () => {
    const { window, encode } = setup();
    expect(usesOf(window, encode({}))).toEqual({ base: "membership" });
    expect(
      usesOf(window, encode({ where: { "custom.c1": { eq: "x" } } })),
    ).toEqual({
      base: "membership",
      custom: ["membership", { column_id: ["c1"] }],
    });
    expect(
      usesOf(
        window,
        encode({
          where: { "custom.c1": { eq: "x" } },
          orderBy: [["custom.cc-2", "desc"]],
        }),
      ),
    ).toEqual({
      base: "membership",
      custom: ["membership", { column_id: ["c1", "cc-2"] }],
    });
  });

  test("the SQL joins each named member once, keyed to the scope, and reads it through its cast", async () => {
    const { window, encode, calls } = setup();
    const params = encode({
      where: { "custom.cc-2": { gt: 3 } },
      orderBy: [["custom.c1", "asc"]],
    });
    await window.loader(params);
    const full = calls.at(-1)!;
    expect(full.sql).toContain(
      `left join "sc_custom_values" "custom__c1" on ("custom__c1"."row_key" = "sc_songs"."id" and "custom__c1"."data_view_id" = $`,
    );
    expect(full.sql).toContain(
      `left join "sc_custom_values" "custom__cc_2d_2"`,
    );
    expect(full.sql).toContain(`("custom__cc_2d_2"."value")::numeric`);
    expect(full.params).toContain(SCOPE);
    expect(full.params).toContain("cc-2");
    // The member it orders by is projected (and its key part cast back through its own type).
    expect(full.sql).toContain(`"__family_0"`);
  });

  test("a member the tuple orders by is folded under `$scoped`, and the order signature reads it", async () => {
    const { window, encode } = setup();
    const params = encode({ orderBy: [["custom.c1", "asc"]] });
    const rows = (await window.loader(params)) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.$scoped).toEqual({ custom__c1: "x" });
    expect(rows[0]).not.toHaveProperty("__family_0");
    const sig = window.membership!;
    if (sig.kind !== "window") throw new Error("a window");
    const moved = { ...rows[0]!, $scoped: { custom__c1: "y" } };
    expect(sig.orderSignatureOf!(rows[0], params)).not.toBe(
      sig.orderSignatureOf!(moved, params),
    );
  });

  test("a member's cast is read at load time: retyping a column changes the SQL of the next load", async () => {
    const { window, encode, calls, members } = setup();
    const params = encode({ where: { "custom.c1": { eq: "x" } } });
    await window.loader(params);
    expect(calls.at(-1)!.sql).not.toContain("::numeric");
    members.set("c1", {
      domain: "text",
      cast: { sql: (raw) => sql`upper(${raw})`, sqlType: "text" },
    });
    await window.loader(params);
    expect(calls.at(-1)!.sql).toContain(`upper("custom__c1"."value")`);
  });

  test("retyping a member a tuple SORTS by re-renders its order: ORDER BY and projection read the new cast", async () => {
    const { window, encode, calls, members } = setup();
    const params = encode({ orderBy: [["custom.c1", "asc"]] });
    await window.loader(params);
    const before = calls.at(-1)!.sql;
    expect(before).not.toContain("::numeric");
    members.set("c1", {
      domain: "number",
      cast: { sql: (raw) => sql`(${raw})::numeric`, sqlType: "numeric" },
    });
    await window.loader(params);
    const after = calls.at(-1)!.sql;
    // The ORDER BY, the `$scoped` projection and the row-key part all read
    // the member through its new cast — the memoized order is not the old one.
    expect(after).toMatch(/order by \("custom__c1"\."value"\)::numeric/);
    expect(after).toContain(`("custom__c1"."value")::numeric as "__family_0"`);
    expect(after).toContain(
      `("custom__c1"."value")::numeric::text as "__row_key_0"`,
    );
  });

  test("a member the scope no longer has fails the load loudly", async () => {
    const { window, encode, members } = setup();
    const params = encode({ where: { "custom.c1": { eq: "x" } } });
    members.delete("c1");
    const error = await Promise.resolve(window.loader(params)).then(
      () => null,
      (err: unknown) => err,
    );
    expect(String(error)).toMatch(/"custom\.c1"/);
  });

  test("the scope's recomputeOn reaches the window (not the point read)", () => {
    const { window, c, set } = setup();
    expect(window.recomputeOn).toEqual([RECOMPUTE]);
    // The fold recorded the scope the set serves — what its owner watches.
    expect([...set.scopes()]).toEqual([SCOPE]);
    const specs = compileCollection(
      c,
      { from: songs, db: recordingQueryDb().db },
      [],
      [set],
    );
    expect(
      compileWindowQuery(c.rows, specs.rows).serverOpts.recomputeOn,
    ).toBeUndefined();
  });

  test("provenance: every shape joins exactly the members usesOf names", async () => {
    const { window, encode, calls } = setup();
    const params = encode({
      where: { "custom.cc-2": { gt: 1 } },
      orderBy: [["custom.c1", "desc"]],
    });
    const members = [
      ...(window.routes!.usesOf(params).get("custom")?.match?.column_id ?? []),
    ].sort();
    const joined = (s: string) =>
      [...s.matchAll(/left join "sc_custom_values" "custom__([^"]+)"/g)]
        .map((m) => m[1]!)
        .sort();
    await window.loader(params);
    await window.loader(params, { affectedIds: ["a"] });
    const membership = window.membership!;
    if (membership.kind !== "window") throw new Error("a window");
    await membership.windowIdsOf(params);
    const shapes = calls.slice(-3).map((q) => joined(q.sql));
    expect(members).toEqual(["c1", "cc-2"]);
    for (const shape of shapes) expect(shape).toEqual(["c1", "cc_2d_2"]);
  });

  test("a collection with no column scope is refused scoped sets", () => {
    const { set } = setup();
    const plain = liveCollection(`test.live.scoped-${seq++}`, {
      row: z.object({ id: z.string(), n: z.number() }),
      id: "id",
      filterable: { n: liveNumber() },
      sortable: ["n"],
      default: { orderBy: [["n", "asc"]], limit: 10 },
      maxLimit: 50,
    });
    expect(() =>
      compileCollection(
        plain,
        { from: songs, db: recordingQueryDb().db },
        [],
        [set],
      ),
    ).toThrow(/declares no `columnScope`/);
  });

  test("the codec refuses a scoped set of another scope, and one on a collection without a scope", () => {
    const { c } = setup();
    const other = scopedLiveColumns("another.surface", "custom", {
      c1: { domain: "text", sortable: true },
    });
    expect(() =>
      c.window.window.encode({
        where: { "custom.c1": { eq: "x" } } as never,
        columns: [other],
      }),
    ).toThrow(/belong to scope "another\.surface"/);
  });
});
