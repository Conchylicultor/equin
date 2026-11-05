/**
 * `serveCollection` over a SCOPED column set (P3 of
 * research/2026-09-29-global-scoped-change-routing.md — a DataView surface's
 * custom columns), without a database: the recording `QueryDb` renders every
 * query, so each case reads the SQL a tuple runs.
 *
 * - the scope is the QUERY's (`scope`, the surface asking): one route for the
 *   whole set over every scope (an alias on the host key, matched per tuple on
 *   the scope it names and the members it reads);
 * - a scope no set serves is refused at the params gate; a served one is
 *   observed once (its owner starts watching its members);
 * - a tuple joins exactly the members its where / order names, as membership;
 * - a member's value reads through its type's cast, looked up at load time;
 * - a member a tuple ORDERS BY is projected and folded under `$scoped`, where
 *   the order signature reads it;
 * - `recomputeOn` reaches the window per tuple: the tuple of the scope it names;
 * - provenance: every shape joins exactly the members `usesOf` names.
 *
 * Run: `./equin test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";
import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { sql } from "drizzle-orm";
import { integer, pgTable, primaryKey, text } from "drizzle-orm/pg-core";
import { familyMember } from "@plugins/network/plugins/live/plugins/query-resource/core";
import { familyMemberAlias } from "@plugins/network/plugins/live/plugins/query-resource/core/testing";
import {
  compileWindowQuery,
  recordingQueryDb,
} from "@plugins/network/plugins/live/plugins/query-resource/server/testing";
import {
  liveCollection,
  scopedLiveColumns,
  type LiveWindowParams,
} from "@plugins/network/plugins/live/core";
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
const OTHER = "other.surface";
const RESOURCE = { key: "test.defs" } as never;

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
    serves: (scope) => scope === SCOPE || scope === OTHER,
    members: (scope) => (scope === SCOPE ? members : new Map()),
    recomputeOn: {
      resource: RESOURCE,
      params: (scope) => ({ dataViewId: scope }),
    },
    watch: (scope) => watched.push(scope),
  });
  const watched: string[] = [];
  const c = liveCollection(`test.live.scoped-${seq++}`, {
    fields: {
      id: textField({ label: "Id", filterable: false }),
      title: textField({ label: "Title" }),
      n: intField({ label: "N" }),
    },
    id: "id",
    sortable: ["title", "n"],
    default: { orderBy: [["n", "asc"]], limit: 10 },
    maxLimit: 50,
    scopedColumns: true,
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
  const specs = compileCollection(c, { from: songs, db: recording.db }, [set]);
  const window = compileWindowQuery(c.window, specs.window).serverOpts;
  // What the browser hands the codec: the members as it knows them.
  const handle = scopedLiveColumns(SCOPE, "custom", {
    c1: { domain: "text", sortable: true },
    "cc-2": { domain: "number", sortable: true },
  });
  // A query bringing the set, naming its members by wire name (`custom.<id>`).
  const encode = (
    q: Omit<
      NonNullable<
        Parameters<typeof c.window.window.encode<readonly [typeof handle]>>[0]
      >,
      "columns"
    >,
  ) => c.window.window.encode({ ...q, columns: [handle] });
  /** A member's join alias in the test scope. */
  const alias = (member: string) =>
    familyMember(set.family, member, SCOPE).alias;
  return { c, set, members, watched, window, encode, alias, ...recording };
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

  test("a scoped member's alias names its scope too: one member id in two scopes is two joins", () => {
    const { set, alias } = setup();
    expect(alias("c1")).toBe(familyMemberAlias("custom", `${SCOPE}\u0000c1`));
    expect(familyMember(set.family, "c1", OTHER).alias).not.toBe(alias("c1"));
    expect(() => familyMember(set.family, "c1")).toThrow(/names no scope/);
  });

  test("one route for the whole set, whatever the scope: an alias on the host key, matched on the scope and the member", () => {
    const { window } = setup();
    expect(window.routes!.routes.find((r) => r.id === "custom")).toEqual({
      id: "custom",
      table: "sc_custom_values",
      map: { kind: "alias", column: "row_key" },
      rows: {},
      match: ["column_id", "data_view_id"],
      columns: ["data_view_id", "row_key", "column_id", "value"],
    });
  });

  test("the scope is the query's: a tuple naming a member carries it, and the gate refuses one no set serves", () => {
    const { window, encode, watched } = setup();
    const params = encode({ where: { "custom.c1": { eq: "x" } } });
    expect(params.scope).toBe(SCOPE);
    expect(encode({}).scope).toBeUndefined();
    window.validateParams!(params);
    window.validateParams!(params);
    // Observed once: its owner watches the scope's members from then on.
    expect(watched).toEqual([SCOPE]);
    expect(() =>
      window.validateParams!({ ...params, scope: "nowhere" }),
    ).toThrow(/served by no scoped column set/);
    // A scope with no member of that name: the strict decode refuses it.
    expect(() => window.validateParams!({ ...params, scope: OTHER })).toThrow(
      /not a filterable column|custom\.c1/,
    );
  });

  test("a tuple reads the set only when its where / order names a member — as membership, matching exactly those members", () => {
    const { window, encode } = setup();
    expect(usesOf(window, encode({}))).toEqual({ base: "membership" });
    expect(
      usesOf(window, encode({ where: { "custom.c1": { eq: "x" } } })),
    ).toEqual({
      base: "membership",
      custom: ["membership", { column_id: ["c1"], data_view_id: [SCOPE] }],
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
      custom: [
        "membership",
        { column_id: ["c1", "cc-2"], data_view_id: [SCOPE] },
      ],
    });
  });

  test("the SQL joins each named member once, keyed to the scope, and reads it through its cast", async () => {
    const { window, encode, calls, alias } = setup();
    const params = encode({
      where: { "custom.cc-2": { gt: 3 } },
      orderBy: [["custom.c1", "asc"]],
    });
    await window.loader(params);
    const full = calls.at(-1)!;
    const c1 = alias("c1");
    const cc2 = alias("cc-2");
    expect(full.sql).toContain(
      `left join "sc_custom_values" "${c1}" on ("${c1}"."row_key" = "sc_songs"."id" and "${c1}"."data_view_id" = $`,
    );
    expect(full.sql).toContain(`left join "sc_custom_values" "${cc2}"`);
    expect(full.sql).toContain(`("${cc2}"."value")::numeric`);
    expect(full.params).toContain(SCOPE);
    expect(full.params).toContain("cc-2");
    // The member it orders by is projected (and its key part cast back through its own type).
    expect(full.sql).toContain(`"__family_0"`);
  });

  test("a member the tuple orders by is folded under `$scoped`, and the order signature reads it", async () => {
    const { window, encode, alias } = setup();
    const params = encode({ orderBy: [["custom.c1", "asc"]] });
    const rows = (await window.loader(params)) as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.$scoped).toEqual({ [alias("c1")]: "x" });
    expect(rows[0]).not.toHaveProperty("__family_0");
    const sig = window.membership!;
    if (sig.kind !== "window") throw new Error("a window");
    const moved = { ...rows[0]!, $scoped: { [alias("c1")]: "y" } };
    expect(sig.orderSignatureOf!(rows[0], params)).not.toBe(
      sig.orderSignatureOf!(moved, params),
    );
  });

  test("a member's cast is read at load time: retyping a column changes the SQL of the next load", async () => {
    const { window, encode, calls, members, alias } = setup();
    const params = encode({ where: { "custom.c1": { eq: "x" } } });
    await window.loader(params);
    expect(calls.at(-1)!.sql).not.toContain("::numeric");
    members.set("c1", {
      domain: "text",
      cast: { sql: (raw) => sql`upper(${raw})`, sqlType: "text" },
    });
    await window.loader(params);
    expect(calls.at(-1)!.sql).toContain(`upper("${alias("c1")}"."value")`);
  });

  test("retyping a member a tuple SORTS by re-renders its order: ORDER BY and projection read the new cast", async () => {
    const { window, encode, calls, members, alias } = setup();
    const c1 = alias("c1");
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
    expect(after).toContain(`order by ("${c1}"."value")::numeric`);
    expect(after).toContain(`("${c1}"."value")::numeric as "__family_0"`);
    expect(after).toContain(
      `("${c1}"."value")::numeric::text as "__row_key_0"`,
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

  test("recomputeOn reaches the window per tuple — the members' tuple of the scope it names (not the point read)", () => {
    const { window, c, set, encode } = setup();
    expect(window.recomputeOn).toHaveLength(1);
    const [on] = window.recomputeOn!;
    expect(on!.resource).toBe(RESOURCE);
    expect(
      on!.paramsOf!(encode({ where: { "custom.c1": { eq: "x" } } })),
    ).toEqual({
      dataViewId: SCOPE,
    });
    // A tuple naming no scope compiles from no members' tuple.
    expect(on!.paramsOf!(encode({}))).toBeNull();
    const specs = compileCollection(
      c,
      { from: songs, db: recordingQueryDb().db },
      [set],
    );
    expect(
      compileWindowQuery(c.rows, specs.rows).serverOpts.recomputeOn,
    ).toBeUndefined();
  });

  test("provenance: every shape joins exactly the members usesOf names", async () => {
    const { window, encode, calls, set: setOf } = setup();
    const params = encode({
      where: { "custom.cc-2": { gt: 1 } },
      orderBy: [["custom.c1", "desc"]],
    });
    const members = [
      ...(window.routes!.usesOf(params).get("custom")?.match?.column_id ?? []),
    ].sort();
    const aliasOf = new Map(
      ["c1", "cc-2"].map((m) => [
        familyMember(setOf.family, m, SCOPE).alias,
        m,
      ]),
    );
    const joined = (s: string) =>
      [...s.matchAll(/left join "sc_custom_values" "([^"]+)"/g)]
        .map((m) => aliasOf.get(m[1]!) ?? m[1]!)
        .sort();
    await window.loader(params);
    await window.loader(params, { affectedIds: ["a"] });
    const membership = window.membership!;
    if (membership.kind !== "window") throw new Error("a window");
    await membership.windowIdsOf(params);
    const shapes = calls.slice(-3).map((q) => joined(q.sql));
    expect(members).toEqual(["c1", "cc-2"]);
    for (const shape of shapes) expect(shape).toEqual(["c1", "cc-2"]);
  });

  test("a collection not declared `scopedColumns` is refused scoped sets", () => {
    const { set } = setup();
    const plain = liveCollection(`test.live.scoped-${seq++}`, {
      fields: {
        id: textField({ label: "Id", filterable: false }),
        n: intField({ label: "N" }),
      },
      id: "id",
      sortable: ["n"],
      default: { orderBy: [["n", "asc"]], limit: 10 },
      maxLimit: 50,
    });
    expect(() =>
      compileCollection(plain, { from: songs, db: recordingQueryDb().db }, [
        set,
      ]),
    ).toThrow(/not declared `scopedColumns`/);
  });

  test("two surfaces, one collection: each tuple joins its own scope's members, through the one route", async () => {
    const { c } = setup();
    const other = scopedLiveColumns(OTHER, "custom", {
      c1: { domain: "text", sortable: true },
    });
    // The other surface has a member "c1" too (its own definition).
    const twoScopes = serveScopedColumns({
      name: "custom",
      table: values,
      scope: values.dataViewId,
      hostKey: values.rowKey,
      member: values.columnId,
      value: values.value,
      serves: () => true,
      members: () => new Map([["c1", { domain: "text" as const }]]),
      recomputeOn: { resource: RESOURCE, params: (s) => ({ dataViewId: s }) },
      watch: () => {},
    });
    const specs = compileCollection(
      c,
      { from: songs, db: recordingQueryDb().db },
      [twoScopes],
    );
    const w = compileWindowQuery(c.window, specs.window).serverOpts;
    const params = c.window.window.encode({
      where: { "custom.c1": { eq: "x" } },
      columns: [other],
    });
    expect(params.scope).toBe(OTHER);
    expect([
      ...w.routes!.usesOf(params).get("custom")!.match!.data_view_id!,
    ]).toEqual([OTHER]);
  });
});
