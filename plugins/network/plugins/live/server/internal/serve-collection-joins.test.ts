/**
 * `serveCollection` over declared joins (P2 of
 * research/2026-09-29-global-scoped-change-routing.md), without a database:
 * the recording `QueryDb` renders every query through drizzle's real dialect,
 * so each suite reads the SQL — and the relations — every compiled shape runs.
 *
 * - the routes a joined collection emits (kind per join, exact columns);
 * - each tuple's read-set and role (`usesOf`): projected-only joins are
 *   `value`, joins its where / order reads (through a chain too) and required
 *   lookups are `membership`;
 * - the provenance property (Verification §4): for random decoded params, the
 *   relations in the rendered SQL of every shape — full, scoped, ids, point,
 *   groups — are exactly the route occurrences `usesOf(params)` names;
 * - A4 / T2: every misdeclared join or override throws at module eval, or
 *   does not compile.
 *
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { getTableColumns, sql } from "drizzle-orm";
import {
  customType,
  integer,
  pgTable,
  primaryKey,
  text,
} from "drizzle-orm/pg-core";
import { withWire } from "@plugins/database/plugins/sql-column/server";
import type {
  ExtensionJoin,
  JoinSpec,
  KeyedSideJoin,
  LookupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import type { ResourceParams } from "@plugins/framework/plugins/resource-runtime/core";
import {
  compileWindowQuery,
  recordingQueryDb,
  type RecordedQuery,
} from "@plugins/infra/plugins/query-resource/server/testing";
import {
  liveCollection,
  type LiveWhere,
  type LiveWindowParams,
} from "@plugins/network/plugins/live/core";
import {
  type Filter,
  and,
  liveNumber,
  liveText,
  or,
} from "@plugins/network/plugins/live/plugins/filter/core";
import { compileCollection } from "./serve-collection";

// ── The schema: a host, a 1:1 extension, a chained N:1 lookup, a keyed side ──

const songs = pgTable("songs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  artistId: text("artist_id"),
  createdAt: integer("created_at").notNull(),
  // Read by no SQL of the collection: never a route column.
  secret: text("secret"),
});
const playback = pgTable("songs_ext_playback", {
  parentId: text("parent_id").primaryKey(),
  lastPlayedAt: integer("last_played_at"),
  plays: integer("plays").notNull(),
  note: text("note"),
});
const artists = pgTable("artists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  labelId: text("label_id"),
});
const labels = pgTable("labels", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
const custom = pgTable(
  "custom_values",
  {
    dataViewId: text("data_view_id").notNull(),
    rowKey: text("row_key").notNull(),
    columnId: text("column_id").notNull(),
    value: text("value"),
  },
  (t) => [primaryKey({ columns: [t.dataViewId, t.rowKey, t.columnId] })],
);

const playbackJoin: ExtensionJoin<"playback", typeof playback> = {
  kind: "extension",
  alias: "playback",
  table: playback,
  key: playback.parentId,
  parentKey: songs.id,
};
const artistJoin = (
  required = false,
): LookupJoin<"artist", typeof artists> => ({
  kind: "lookup",
  alias: "artist",
  table: artists,
  pk: artists.id,
  on: { from: "base", col: songs.artistId },
  required,
});
const labelJoin: LookupJoin<"label", typeof labels> = {
  kind: "lookup",
  alias: "label",
  table: labels,
  pk: labels.id,
  on: { from: "artist", col: artists.labelId },
  required: false,
};
const ccJoin: KeyedSideJoin<"cc", typeof custom> = {
  kind: "keyed-side",
  alias: "cc",
  table: custom,
  selectors: [
    { col: custom.dataViewId, value: "songs" },
    { col: custom.columnId, value: "c1" },
  ],
  hostKey: custom.rowKey,
};

const SongRow = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  lastPlayedAt: z.number().nullable(),
  plays: z.number().nullable(),
  artistName: z.string().nullable(),
  labelName: z.string().nullable(),
  c1: z.string().nullable(),
});

const FILTERABLE = {
  title: liveText(),
  plays: liveNumber(),
  artistName: liveText(),
  labelName: liveText(),
  c1: liveText(),
};
const SORTABLE = [
  "createdAt",
  "title",
  "lastPlayedAt",
  "plays",
  "labelName",
  "c1",
] as const;

let seq = 0;
const SPEC = {
  row: SongRow,
  id: "id",
  filterable: FILTERABLE,
  sortable: SORTABLE,
  default: { orderBy: [["createdAt", "desc"]], limit: 10 },
  maxLimit: 50,
} as const;
const collection = () => liveCollection(`test.live.joins-${seq++}`, SPEC);

function compile(
  opts: {
    required?: boolean;
    script?: (q: RecordedQuery) => unknown[];
  } = {},
) {
  const c = collection();
  const recording = recordingQueryDb(opts.script);
  const specs = compileCollection(c, {
    from: songs,
    joins: [playbackJoin, artistJoin(opts.required), labelJoin, ccJoin],
    columns: {
      lastPlayedAt: (j) => j.playback.lastPlayedAt,
      plays: (j) => j.playback.plays,
      artistName: (j) => j.artist.name,
      labelName: (j) => j.label.name,
      c1: (j) => j.cc.value,
    },
    db: recording.db,
  });
  const window = compileWindowQuery(c.window, specs.window).serverOpts;
  const rows = compileWindowQuery(c.rows, specs.rows).serverOpts;
  return { c, specs, window, rows, groups: specs.groups, ...recording };
}

const usesOf = (
  plan: { usesOf(p: ResourceParams): ReadonlyMap<string, { role: string }> },
  params: ResourceParams,
) =>
  Object.fromEntries([...plan.usesOf(params)].map(([id, u]) => [id, u.role]));

// ── Routes ───────────────────────────────────────────────────────────────────

describe("serveCollection with joins — routes", () => {
  test("one route per relation, mapped by its join kind, over exactly the columns the SQL reads", () => {
    const { window } = compile();
    expect(window.routes!.routes).toEqual([
      {
        id: "base",
        table: "songs",
        map: { kind: "identity" },
        // `secret` is read by no SQL of the collection.
        columns: ["id", "title", "artist_id", "created_at"],
      },
      {
        id: "playback",
        table: "songs_ext_playback",
        // The extension's key IS its primary key: the feed's ids are host ids.
        map: { kind: "alias" },
        columns: ["parent_id", "last_played_at", "plays"],
      },
      {
        id: "artist",
        table: "artists",
        // The host references it (`songs.artist_id`): resolved in the drain.
        // Looked up by the table's own PK: the changed values are the feed's
        // `ids`, so no key column is carried (no `column`).
        map: { kind: "reverse", resolve: expect.any(Function) },
        columns: ["id", "name", "label_id"],
      },
      {
        id: "label",
        table: "labels",
        // Reached through `artist` — another table, read host-side of the
        // changed one: complete after commit (A10).
        map: { kind: "reverse", resolve: expect.any(Function) },
        columns: ["id", "name"],
      },
      {
        id: "cc",
        table: "custom_values",
        map: { kind: "alias", column: "row_key" },
        rows: { data_view_id: "songs", column_id: "c1" },
        columns: ["data_view_id", "row_key", "column_id", "value"],
      },
    ]);
  });

  test("the grouping's reach routes are all full, one per relation", () => {
    const { groups } = compile();
    expect(groups.reach.routes.map((r) => [r.id, r.table, r.map.kind])).toEqual(
      [
        ["base", "songs", "full"],
        ["playback", "songs_ext_playback", "full"],
        ["artist", "artists", "full"],
        ["label", "labels", "full"],
        ["cc", "custom_values", "full"],
      ],
    );
  });

  test("a lookup keyed by the host's own id routes like an extension (alias)", () => {
    const c = liveCollection(`test.live.joins-${seq++}`, {
      row: z.object({ id: z.string(), name: z.string().nullable() }),
      id: "id",
      filterable: {},
      sortable: ["id"],
      default: { orderBy: [["id", "asc"]], limit: 10 },
      maxLimit: 50,
    });
    const specs = compileCollection(c, {
      from: songs,
      joins: [
        {
          kind: "lookup",
          alias: "same",
          table: artists,
          pk: artists.id,
          on: { from: "base", col: songs.id },
          required: false,
        },
      ],
      columns: { name: (j) => j.same.name },
      db: recordingQueryDb().db,
    });
    const routes = compileWindowQuery(c.window, specs.window).serverOpts.routes!
      .routes;
    expect(routes[1]!.map).toEqual({ kind: "alias" });
  });
});

// ── Reverse routes (P4): the lookup side resolved to host ids ─────────────────

describe("serveCollection with joins — reverse routes", () => {
  const reverseOf = (
    window: ReturnType<typeof compile>["window"],
    id: string,
  ) => {
    const map = window.routes!.routes.find((r) => r.id === id)!.map;
    if (map.kind !== "reverse") throw new Error(`${id} is not reverse`);
    return map;
  };

  test("a lookup on the base resolves over the host's referencing column: one array param, typed", async () => {
    const { window, calls } = compile();
    await reverseOf(window, "artist").resolve(["a1", "a2"], null, 500);
    expect(calls.at(-1)!.sql).toBe(
      `select distinct "id" from "songs" where "songs"."artist_id" = ANY($1::text[]) limit $2`,
    );
    expect(calls.at(-1)!.params).toEqual([["a1", "a2"], 501]);
  });

  test("a chained lookup probes through its chain; `within` bounds the hosts", async () => {
    const { window, calls } = compile();
    await reverseOf(window, "label").resolve(
      ["l1"],
      new Set(["s1", "s2"]),
      500,
    );
    expect(calls.at(-1)!.sql).toBe(
      `select distinct "songs"."id" from "songs" left join "artists" "artist" on "artist"."id" = "songs"."artist_id" where ("artist"."label_id" = ANY($1::text[]) and "songs"."id" = ANY($2::text[])) limit $3`,
    );
  });

  test("more hosts than the cap answer over-cap; an empty `within` answers none without a query", async () => {
    const { window, calls } = compile({
      script: () => [{ id: "s1" }, { id: "s2" }, { id: "s3" }],
    });
    const map = reverseOf(window, "artist");
    expect(await map.resolve(["a1"], null, 3)).toEqual(["s1", "s2", "s3"]);
    expect(await map.resolve(["a1"], null, 2)).toBe("over-cap");
    const at = calls.length;
    expect(await map.resolve(["a1"], new Set(), 500)).toEqual([]);
    expect(calls.length).toBe(at);
  });

  test("a lookup on a UNIQUE non-PK column keeps `column`: its values are carried keys, not the feed's ids (A4)", async () => {
    const studios = pgTable("studios", {
      id: text("id").primaryKey(),
      slug: text("slug").notNull().unique(),
      name: text("name").notNull(),
    });
    const films = pgTable("films", {
      id: text("id").primaryKey(),
      studioSlug: text("studio_slug"),
    });
    const c = liveCollection(`test.live.joins-${seq++}`, {
      row: z.object({ id: z.string(), studio: z.string().nullable() }),
      id: "id",
      filterable: {},
      sortable: ["id"],
      default: { orderBy: [["id", "asc"]], limit: 10 },
      maxLimit: 50,
    });
    const recording = recordingQueryDb();
    const specs = compileCollection(c, {
      from: films,
      joins: [
        {
          kind: "lookup",
          alias: "studio",
          table: studios,
          pk: studios.slug,
          on: { from: "base", col: films.studioSlug },
          required: false,
        },
      ],
      columns: { studio: (j) => j.studio.name },
      db: recording.db,
    });
    const routes = compileWindowQuery(c.window, specs.window).serverOpts.routes!
      .routes;
    const map = routes.find((r) => r.id === "studio")!.map;
    expect(map).toEqual({
      kind: "reverse",
      column: "slug",
      resolve: expect.any(Function),
    });
    if (map.kind !== "reverse") throw new Error("not reverse");
    await map.resolve(["acme"], null, 500);
    expect(recording.calls.at(-1)!.sql).toBe(
      `select distinct "id" from "films" where "films"."studio_slug" = ANY($1::text[]) limit $2`,
    );
  });

  test("a lookup reached through a join over the SAME table needs the pre-image: full, with the reason (A10)", () => {
    const people = pgTable("people", {
      id: text("id").primaryKey(),
      name: text("name").notNull(),
      mentorId: text("mentor_id"),
    });
    const tasks = pgTable("tasks", {
      id: text("id").primaryKey(),
      ownerId: text("owner_id"),
    });
    const c = liveCollection(`test.live.joins-${seq++}`, {
      row: z.object({
        id: z.string(),
        owner: z.string().nullable(),
        mentor: z.string().nullable(),
      }),
      id: "id",
      filterable: {},
      sortable: ["id"],
      default: { orderBy: [["id", "asc"]], limit: 10 },
      maxLimit: 50,
    });
    const specs = compileCollection(c, {
      from: tasks,
      joins: [
        {
          kind: "lookup",
          alias: "owner",
          table: people,
          pk: people.id,
          on: { from: "base", col: tasks.ownerId },
          required: false,
        },
        {
          kind: "lookup",
          alias: "mentor",
          table: people,
          pk: people.id,
          on: { from: "owner", col: people.mentorId },
          required: false,
        },
      ],
      columns: {
        owner: (j) => j.owner.name,
        mentor: (j) => j.mentor.name,
      },
      db: recordingQueryDb().db,
    });
    const routes = compileWindowQuery(c.window, specs.window).serverOpts.routes!
      .routes;
    expect(routes.find((r) => r.id === "owner")!.map.kind).toBe("reverse");
    const mentor = routes.find((r) => r.id === "mentor")!.map;
    expect(mentor.kind).toBe("full");
    expect(mentor.kind === "full" && mentor.reason).toMatch(
      /pre-image needed: lookup "mentor" is reached through "owner", a join over the changed table "people"/,
    );
  });

  test("a self-join on the base (a node's parent) is identity + reverse on one table: host-side, complete", async () => {
    const nodes = pgTable("nodes", {
      id: text("id").primaryKey(),
      name: text("name").notNull(),
      parentId: text("parent_id"),
    });
    const c = liveCollection(`test.live.joins-${seq++}`, {
      row: z.object({
        id: z.string(),
        name: z.string(),
        parentName: z.string().nullable(),
      }),
      id: "id",
      filterable: {},
      sortable: ["name"],
      default: { orderBy: [["name", "asc"]], limit: 10 },
      maxLimit: 50,
    });
    const recording = recordingQueryDb();
    const specs = compileCollection(c, {
      from: nodes,
      joins: [
        {
          kind: "lookup",
          alias: "parent",
          table: nodes,
          pk: nodes.id,
          on: { from: "base", col: nodes.parentId },
          required: false,
        },
      ],
      columns: { parentName: (j) => j.parent.name },
      db: recording.db,
    });
    const routes = compileWindowQuery(c.window, specs.window).serverOpts.routes!
      .routes;
    expect(routes.map((r) => [r.id, r.table, r.map.kind])).toEqual([
      ["base", "nodes", "identity"],
      ["parent", "nodes", "reverse"],
    ]);
    const map = routes[1]!.map;
    if (map.kind !== "reverse") throw new Error("not reverse");
    await map.resolve(["n1"], null, 500);
    expect(recording.calls.at(-1)!.sql).toBe(
      `select distinct "id" from "nodes" where "nodes"."parent_id" = ANY($1::text[]) limit $2`,
    );
  });
});

// ── Default scopes: a predicate a tuple's filter drops by naming its column ───

describe("serveCollection — default scopes", () => {
  function compileDefaults() {
    const c = collection();
    const recording = recordingQueryDb();
    const specs = compileCollection(c, {
      from: songs,
      joins: [artistJoin(true), labelJoin],
      columns: {
        lastPlayedAt: (j) => j.base.createdAt,
        plays: (j) => j.base.createdAt,
        artistName: (j) => j.artist.name,
        labelName: (j) => j.label.name,
        c1: (j) => j.base.title,
      },
      defaults: [
        {
          unless: "artistName",
          where: (j) => sql`${j.artist.name} <> 'hidden'`,
        },
      ],
      db: recording.db,
    });
    const window = compileWindowQuery(c.window, specs.window).serverOpts;
    const rows = compileWindowQuery(c.rows, specs.rows).serverOpts;
    return { c, specs, window, rows, ...recording };
  }

  test("ANDed into a window tuple whose filter does not name its column; dropped when it does", async () => {
    const { c, window, calls } = compileDefaults();
    await window.loader(c.window.window.encode());
    expect(calls.at(-1)!.sql).toContain(`"artist"."name" <> 'hidden'`);
    await window.loader(
      c.window.window.encode({ where: { artistName: { contains: "x" } } }),
    );
    expect(calls.at(-1)!.sql).not.toContain(`<> 'hidden'`);
  });

  test("its column is a route column and moves the tuples it applies to", () => {
    const { c, window } = compileDefaults();
    expect(
      window.routes!.routes.find((r) => r.id === "artist")!.columns,
    ).toContain("name");
    const moves = (params: LiveWindowParams) =>
      window.routes!.usesOf(params).get("artist")!.moves;
    expect(moves(c.window.window.encode())).toEqual(["id", "name"]);
    expect(
      moves(c.window.window.encode({ where: { title: { contains: "x" } } })),
    ).toEqual(["id", "name"]);
  });

  test("never ANDed into the point read (it ignores every client filter); ANDed into a grouping", async () => {
    const { c, rows, specs, calls } = compileDefaults();
    await rows.loader(c.rows.point.encode(["s1"]));
    expect(calls.at(-1)!.sql).not.toContain(`<> 'hidden'`);
    await specs.groups.loader(c.groups.groups.encode({ groupBy: "title" }));
    expect(calls.at(-1)!.sql).toContain(`"artist"."name" <> 'hidden'`);
  });

  test("an `unless` naming no filterable column is a type error, and throws at module eval past a cast", () => {
    expect(() =>
      // @ts-expect-error — `unless` is typed to the collection's filterable names.
      compileCollection(collection(), {
        from: songs,
        joins: [artistJoin(), labelJoin],
        columns: {
          lastPlayedAt: (j) => j.base.createdAt,
          plays: (j) => j.base.createdAt,
          artistName: (j) => j.artist.name,
          labelName: (j) => j.label.name,
          c1: (j) => j.base.title,
        },
        defaults: [{ unless: "createdAt", where: sql`true` }],
        db: recordingQueryDb().db,
      }),
    ).toThrow(/names no filterable column/);
  });
});

// ── Moves: the columns whose change can move a tuple (P4) ────────────────────

describe("serveCollection with joins — each membership use's `moves`", () => {
  const movesOf = (
    window: ReturnType<typeof compile>["window"],
    params: LiveWindowParams,
  ) =>
    Object.fromEntries(
      [...window.routes!.usesOf(params)].map(([id, u]) => [
        id,
        u.role === "membership" ? (u.moves ?? "every column") : "value",
      ]),
    );

  test("the default tuple moves on its order column only; a projected join is value", () => {
    const { c, window } = compile();
    expect(movesOf(window, c.window.window.encode())).toEqual({
      base: ["created_at"],
      playback: "value",
      artist: "value",
      label: "value",
      cc: "value",
    });
  });

  test("a filter through a chained lookup: each hop moves on its condition, the filtered one on its column too", () => {
    const { c, window } = compile();
    const params = c.window.window.encode({ where: { labelName: "x" } });
    expect(movesOf(window, params)).toMatchObject({
      base: ["artist_id", "created_at"],
      artist: ["id", "label_id"],
      label: ["id", "name"],
    });
  });

  test("a required lookup moves on its join condition even when nothing filters it", () => {
    const { c, window } = compile({ required: true });
    expect(movesOf(window, c.window.window.encode())).toMatchObject({
      base: ["artist_id", "created_at"],
      artist: ["id"],
    });
  });
});

// ── Roles ────────────────────────────────────────────────────────────────────

describe("serveCollection with joins — each tuple's read-set and role", () => {
  test("the default tuple projects every join: base is membership, every join value", () => {
    const { c, window } = compile();
    expect(usesOf(window.routes!, c.window.window.encode())).toEqual({
      base: "membership",
      playback: "value",
      artist: "value",
      label: "value",
      cc: "value",
    });
  });

  test("sorting by a joined column makes that join membership", () => {
    const { c, window } = compile();
    const params = c.window.window.encode({
      orderBy: [["lastPlayedAt", "desc"]],
    });
    expect(usesOf(window.routes!, params)).toMatchObject({
      playback: "membership",
      artist: "value",
    });
  });

  test("filtering through a chained lookup makes the whole chain membership", () => {
    const { c, window } = compile();
    const params = c.window.window.encode({
      where: { column: "labelName", op: "eq", operand: "x" },
    });
    expect(usesOf(window.routes!, params)).toEqual({
      base: "membership",
      playback: "value",
      artist: "membership",
      label: "membership",
      cc: "value",
    });
  });

  test("a required (INNER) lookup is membership for every tuple", () => {
    const { c, window } = compile({ required: true });
    expect(usesOf(window.routes!, c.window.window.encode())).toMatchObject({
      artist: "membership",
      label: "value",
    });
  });

  test("a base where reading a join makes it membership for every tuple", () => {
    const c = collection();
    const specs = compileCollection(c, {
      from: songs,
      joins: [playbackJoin, artistJoin(), labelJoin, ccJoin],
      columns: {
        lastPlayedAt: (j) => j.playback.lastPlayedAt,
        plays: (j) => j.playback.plays,
        artistName: (j) => j.artist.name,
        labelName: (j) => j.label.name,
        c1: (j) => j.cc.value,
      },
      where: (j) => sql`${j.playback.plays} > 0`,
      db: recordingQueryDb().db,
    });
    const window = compileWindowQuery(c.window, specs.window).serverOpts;
    expect(usesOf(window.routes!, c.window.window.encode())).toMatchObject({
      playback: "membership",
      artist: "value",
    });
    // A grouping by a base column still reads the join its base where names.
    expect(
      usesOf(specs.groups.reach, c.groups.groups.encode({ groupBy: "title" })),
    ).toEqual({ base: "membership", playback: "membership" });
  });

  test("a grouping joins only what its column and where read (and required lookups)", () => {
    const { c, groups } = compile();
    expect(
      usesOf(groups.reach, c.groups.groups.encode({ groupBy: "title" })),
    ).toEqual({ base: "membership" });
    expect(
      usesOf(groups.reach, c.groups.groups.encode({ groupBy: "labelName" })),
    ).toEqual({
      base: "membership",
      artist: "membership",
      label: "membership",
    });
    expect(
      usesOf(
        groups.reach,
        c.groups.groups.encode({
          groupBy: "title",
          where: { column: "plays", op: "gt", operand: 1 },
        }),
      ),
    ).toEqual({ base: "membership", playback: "membership" });
  });
});

// ── SQL ──────────────────────────────────────────────────────────────────────

describe("serveCollection with joins — the SQL", () => {
  test("every shape joins by alias, and a joined column sorts like a base one", async () => {
    const { c, window, rows, calls } = compile();
    const params = c.window.window.encode({ orderBy: [["plays", "asc"]] });
    await window.loader(params);
    await window.loader(params, { affectedIds: ["s1"] });
    await (
      window.membership as { windowIdsOf(p: unknown): Promise<string[]> }
    ).windowIdsOf(params);
    await rows.loader(c.rows.point.encode(["s1"]));
    const extension =
      'left join "songs_ext_playback" "playback" on "playback"."parent_id" = "songs"."id"';
    const chain =
      'left join "artists" "artist" on "artist"."id" = "songs"."artist_id" ' +
      'left join "labels" "label" on "label"."id" = "artist"."label_id"';
    const side =
      'left join "custom_values" "cc" on ("cc"."row_key" = "songs"."id" and "cc"."data_view_id" = $1 and "cc"."column_id" = $2)';
    for (const call of calls) {
      expect(call.sql).toContain(extension);
      expect(call.sql).toContain(chain);
      expect(call.sql).toContain(side);
    }
    expect(calls[0]!.sql).toContain(
      'order by "playback"."plays" ASC NULLS LAST, "songs"."id" ASC NULLS LAST',
    );
  });

  test("the joined columns are projected under their row fields", async () => {
    const { c, window, calls } = compile();
    await window.loader(c.window.window.encode());
    expect(calls[0]!.sql).toStartWith(
      'select "songs"."id", "songs"."title", "songs"."created_at", ' +
        '"playback"."last_played_at", "playback"."plays", "artist"."name", ' +
        '"label"."name", "cc"."value", ' +
        // …then the row key's parts: the order key, then the id.
        '"songs"."created_at"::text as "__row_key_0", "songs"."id"::text as "__row_key_1" ' +
        'from "songs"',
    );
  });
});

// ── Provenance property (Verification §4) ───────────────────────────────────

/** A small deterministic PRNG (mulberry32), so a failing case replays. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** The relations a rendered statement reads: its FROM and every JOIN, by name as rendered. */
function relationsOfSql(text: string): string[] {
  const out: string[] = [];
  const from = /\bfrom "([^"]+)"/g;
  const join = /\b(?:left|inner) join "([^"]+)" "([^"]+)"/g;
  for (const m of text.matchAll(from)) out.push(m[1]!);
  for (const m of text.matchAll(join)) out.push(m[2]!);
  return out;
}

// A join clause and its condition (`on "a"."x" = "b"."y"`, or a parenthesized
// conjunction), as drizzle renders them.
const JOIN_CLAUSE =
  /\b(left|inner) join "[^"]+" "([^"]+)" on (?:\([^)]*\)|"[^"]+"\."[^"]+" = "[^"]+"\."[^"]+")/g;
const COLUMN_REF = /"([^"]+)"\."[^"]+"/g;

/**
 * Independent of `relationsOfSql`'s FROM / JOIN reading: every `"rel"."col"`
 * the statement references names a relation it joins (or its FROM), and every
 * join it makes is referenced OUTSIDE its own condition — projected, filtered,
 * ordered — or is required (INNER), or is an ancestor (`parents`) of one that
 * is. A `where` naming `"cc"."value"` without joining `cc`, or a join nothing
 * reads, fails here. The ids-only `windowIdsOf` query is exempt from the
 * second half: it joins its tuple's whole read-set by design (a projected-only
 * join included), so it and the loader read one relation set — which
 * `relationsOfSql` already compares.
 */
function expectJoinsMatchReferences(
  text: string,
  parents: Readonly<Record<string, string>>,
  what: string,
): void {
  const joined = new Set(relationsOfSql(text));
  const required = new Set<string>();
  for (const m of text.matchAll(JOIN_CLAUSE)) {
    if (m[1] === "inner") required.add(m[2]!);
  }
  for (const m of text.matchAll(COLUMN_REF)) {
    expect({ what, reference: m[1], joined: joined.has(m[1]!) }).toEqual({
      what,
      reference: m[1],
      joined: true,
    });
  }
  if (/^select "(?:[^"]+"\.)?"?id" from/.test(text)) return;
  const outside = text.replace(JOIN_CLAUSE, "");
  const needed = new Set(required);
  for (const m of outside.matchAll(COLUMN_REF)) needed.add(m[1]!);
  for (const rel of [...needed]) {
    for (let at = parents[rel]; at !== undefined; at = parents[at]) {
      needed.add(at);
    }
  }
  for (const m of text.matchAll(JOIN_CLAUSE)) {
    expect({ what, join: m[2], needed: needed.has(m[2]!) }).toEqual({
      what,
      join: m[2],
      needed: true,
    });
  }
}

describe("serveCollection with joins — provenance property", () => {
  const TEXT_FIELDS = ["title", "artistName", "labelName", "c1"] as const;

  function randomFilter(rand: () => number, depth = 0): Filter | undefined {
    const n = Math.floor(rand() * 3);
    if (n === 0) return undefined;
    const leaves: Filter[] = [];
    for (let i = 0; i < n; i++) {
      if (depth < 1 && rand() < 0.25) {
        const nested = randomFilter(rand, depth + 1);
        if (nested) leaves.push(nested);
        continue;
      }
      if (rand() < 0.3) {
        leaves.push({
          column: "plays",
          op: rand() < 0.5 ? "gt" : "lte",
          operand: Math.floor(rand() * 10),
        });
      } else {
        const column = TEXT_FIELDS[Math.floor(rand() * TEXT_FIELDS.length)]!;
        leaves.push(
          rand() < 0.3
            ? { column, op: "isEmpty" }
            : { column, op: rand() < 0.5 ? "eq" : "ne", operand: "v" },
        );
      }
    }
    if (leaves.length === 0) return undefined;
    if (leaves.length === 1) return leaves[0];
    return rand() < 0.5 ? and(...leaves) : or(...leaves);
  }

  // A generated tree is a `Filter` over this collection's own columns and
  // domains, which the codec checks again when it encodes.
  const randomWhere = (rand: () => number) =>
    randomFilter(rand) as LiveWhere<typeof FILTERABLE> | undefined;

  test("for random params, every shape's SQL reads exactly the relations usesOf names", async () => {
    const rand = prng(20260929);
    for (const required of [false, true]) {
      const { c, window, rows, groups, calls } = compile({
        required,
      });
      const idsOf = (
        window.membership as {
          windowIdsOf(p: unknown): Promise<string[]>;
        }
      ).windowIdsOf;
      const routeTable = new Map(
        window.routes!.routes.map((r) => [r.id, r.table]),
      );
      // A rendered relation name → its route id: the base renders under its
      // table name, a join under its alias.
      const routeIdOf = (name: string) => (name === "songs" ? "base" : name);
      const expectReads = (
        call: RecordedQuery,
        uses: ReadonlyMap<string, unknown>,
        what: string,
      ) => {
        const read = relationsOfSql(call.sql).map(routeIdOf).sort();
        expect({ what, read }).toEqual({ what, read: [...uses.keys()].sort() });
        for (const id of read) expect(routeTable.has(id)).toBe(true);
        expectJoinsMatchReferences(call.sql, { label: "artist" }, what);
      };

      // A random row key of a one-key order: the key's text (or NULL), then the id.
      const randomCut = (): string =>
        JSON.stringify([
          rand() < 0.2 ? null : String(Math.floor(rand() * 9)),
          `s${Math.floor(rand() * 9)}`,
        ]);
      for (let i = 0; i < 150; i++) {
        const sort = SORTABLE[Math.floor(rand() * SORTABLE.length)]!;
        const params = c.window.window.encode(
          {
            ...(rand() < 0.8
              ? { orderBy: [[sort, rand() < 0.5 ? "asc" : "desc"]] }
              : {}),
            where: randomWhere(rand),
            limit: 1 + Math.floor(rand() * 50),
          },
          // Segment cuts read only order columns: the read-set is unchanged.
          {
            ...(rand() < 0.4 ? { after: randomCut() } : {}),
            ...(rand() < 0.4 ? { until: randomCut() } : {}),
          },
        );
        const uses = window.routes!.usesOf(params);
        let at = calls.length;
        await window.loader(params);
        await window.loader(params, { affectedIds: ["s1", "s2"] });
        await idsOf(params);
        for (const call of calls.slice(at)) {
          expectReads(call, uses, JSON.stringify(params));
        }

        const point = c.rows.point.encode(["s1"]);
        at = calls.length;
        await rows.loader(point);
        expectReads(calls[at]!, rows.routes!.usesOf(point), "point");

        const groupBy = (
          Object.keys(FILTERABLE) as (keyof typeof FILTERABLE)[]
        )[Math.floor(rand() * 5)]!;
        const gp = c.groups.groups.encode({
          groupBy,
          where: randomWhere(rand),
        });
        at = calls.length;
        await groups.loader(gp);
        expectReads(
          calls[at]!,
          groups.reach.usesOf(gp),
          `groups ${JSON.stringify(gp)}`,
        );
      }
    }
  });
});

// ── A4 / T2: misdeclarations fail at module eval (or do not compile) ─────────

describe("serveCollection with joins — A4 / T2", () => {
  // Lookup-only: the binding and the joins are checked all the same.
  const lookupOnly = () =>
    liveCollection(`test.live.joins-${seq++}`, {
      row: z.object({ id: z.string(), name: z.string().nullable() }),
      id: "id",
    });
  const db = recordingQueryDb().db;

  test("a base ColumnRef naming another table's column throws", () => {
    expect(() =>
      // @ts-expect-error — a hand-written ref naming another table's column (T2)
      compileCollection(lookupOnly(), {
        from: songs,
        columns: { name: () => ({ from: "base", col: artists.name }) },
        db,
      }),
    ).toThrow(/is not a column of the base table "songs"/);
  });

  test("an override naming an undeclared relation does not compile, and throws", () => {
    expect(() =>
      compileCollection(lookupOnly(), {
        from: songs,
        joins: [playbackJoin],
        // @ts-expect-error — "artist" is not a declared join (T2)
        columns: { name: (j) => j.artist.name },
        db,
      }),
    ).toThrow();
  });

  test("a join column that is not its table's throws", () => {
    expect(() =>
      // @ts-expect-error — a hand-written ref naming another table's column (T2)
      compileCollection(lookupOnly(), {
        from: songs,
        joins: [playbackJoin],
        columns: { name: () => ({ from: "playback", col: artists.name }) },
        db,
      }),
    ).toThrow(/is not a column of join "playback"/);
  });

  test("a lookup whose `on` names a later join throws", () => {
    expect(() =>
      compileCollection(lookupOnly(), {
        from: songs,
        joins: [labelJoin, artistJoin()],
        columns: { name: (j) => j.label.name },
        db,
      }),
    ).toThrow(/not the base or a join declared before it/);
  });

  test("a keyed side table whose selectors leave its primary key open throws", () => {
    expect(() =>
      compileCollection(lookupOnly(), {
        from: songs,
        joins: [{ ...ccJoin, selectors: [ccJoin.selectors[0]!] }],
        columns: { name: (j) => j.cc.value },
        db,
      }),
    ).toThrow(/leave primary-key column\(s\) "column_id"/);
  });

  test("an extension of another table throws", () => {
    expect(() =>
      compileCollection(lookupOnly(), {
        from: songs,
        joins: [{ ...playbackJoin, parentKey: artists.id }],
        columns: { name: (j) => j.playback.note },
        db,
      }),
    ).toThrow(/hangs off table "artists", not the base "songs"/);
  });

  test("a reserved or duplicate alias throws", () => {
    for (const joins of [
      [{ ...playbackJoin, alias: "base" }],
      [{ ...playbackJoin, alias: "songs" }],
      [playbackJoin, playbackJoin],
    ]) {
      expect(() =>
        compileCollection(lookupOnly(), {
          from: songs,
          joins: joins as JoinSpec[],
          columns: { name: () => ({ from: "base", col: songs.title }) },
          db,
        }),
      ).toThrow(/reserved|duplicate join alias/);
    }
  });

  test("the id bound to a join throws — it is the base identity", () => {
    expect(() =>
      compileCollection(lookupOnly(), {
        from: songs,
        joins: [playbackJoin],
        columns: {
          id: (j) => j.playback.parentId,
          name: (j) => j.playback.note,
        },
        db,
      }),
    ).toThrow(/the id "id" binds to join "playback"/);
  });

  test("a base where reading an undeclared table throws — declare it as a join", () => {
    expect(() =>
      compileCollection(lookupOnly(), {
        from: songs,
        columns: { name: () => ({ from: "base", col: songs.title }) },
        where: sql`${songs.artistId} in (select ${artists.id} from ${artists})`,
        db,
      }),
    ).toThrow(/neither the base table "songs" nor a declared join/);
  });

  test("a join exposes only its wire columns: a server-only one does not compile, and throws", () => {
    // What `ext.join()` hands over: the entity's wire columns, `note` kept off.
    const { note: _, ...wire } = getTableColumns(playback);
    const wireOnly = { ...playbackJoin, wireColumns: wire };
    expect(() =>
      compileCollection(lookupOnly(), {
        from: songs,
        joins: [wireOnly],
        // @ts-expect-error — `note` is not a wire column of "playback" (T2)
        columns: { name: (j) => j.playback.note },
        db,
      }),
    ).toThrow();
    // A cast past the types still throws, naming the column.
    expect(() =>
      compileCollection(lookupOnly(), {
        from: songs,
        joins: [wireOnly],
        columns: {
          name: () =>
            ({ from: "playback", col: playback.note }) as unknown as {
              from: "playback";
              col: typeof playback.lastPlayedAt;
            },
        },
        db,
      }),
    ).toThrow(/"playback"\."note", which is not a wire column/);
  });

  test("a field read through a LEFT join must be nullable", () => {
    const strict = () =>
      liveCollection(`test.live.joins-${seq++}`, {
        row: z.object({ id: z.string(), plays: z.number() }),
        id: "id",
      });
    // `plays` is NOT NULL in its table, but NULL for a host with no playback row.
    expect(() =>
      compileCollection(strict(), {
        from: songs,
        joins: [playbackJoin],
        columns: { plays: (j) => j.playback.plays },
        db,
      }),
    ).toThrow(
      /"plays" reads "playback"\."plays" through a LEFT join.*nullable/,
    );
    // A required (INNER) lookup never reads NULL for a member: a non-null field is fine.
    const named = liveCollection(`test.live.joins-${seq++}`, {
      row: z.object({ id: z.string(), name: z.string() }),
      id: "id",
    });
    expect(() =>
      compileCollection(named, {
        from: songs,
        joins: [artistJoin(true)],
        columns: { name: (j) => j.artist.name },
        db,
      }),
    ).not.toThrow();
  });
});

// ── A joined column's wire codec ────────────────────────────────────────────

describe("serveCollection with joins — a joined column's wire form", () => {
  const bytes = customType<{ data: Uint8Array; driverData: Uint8Array }>({
    dataType() {
      return "bytea";
    },
  });
  const toBase64 = (b: Uint8Array): string => Buffer.from(b).toString("base64");
  const blobs = pgTable("songs_ext_blob", {
    parentId: text("parent_id").primaryKey(),
    blob: withWire(bytes("blob"), { schema: z.string(), encode: toBase64 }),
  });
  const blobJoin: ExtensionJoin<"bx", typeof blobs> = {
    kind: "extension",
    alias: "bx",
    table: blobs,
    key: blobs.parentId,
    parentKey: songs.id,
  };
  const Row = z.object({ id: z.string(), blob: z.string().nullable() });

  test("is encoded per row, looked up by the table's own column (not the alias proxy)", async () => {
    const c = liveCollection(`test.live.joins-${seq++}`, {
      row: Row,
      id: "id",
    });
    const { db: recording } = recordingQueryDb(() => [
      { id: "s1", blob: Uint8Array.from([1, 2, 3]) },
      { id: "s2", blob: null },
    ]);
    const specs = compileCollection(c, {
      from: songs,
      joins: [blobJoin],
      columns: { blob: (j) => j.bx.blob },
      db: recording,
    });
    const rows = await compileWindowQuery(c.rows, specs.rows).serverOpts.loader(
      c.rows.point.encode(["s1", "s2"]),
    );
    expect(rows).toEqual([
      { id: "s1", blob: toBase64(Uint8Array.from([1, 2, 3])) },
      { id: "s2", blob: null },
    ]);
  });

  test("cannot be filtered, like a base wire-encoded column", () => {
    const c = liveCollection(`test.live.joins-${seq++}`, {
      row: Row,
      id: "id",
      filterable: { blob: liveText() },
      sortable: ["id"],
      default: { orderBy: [["id", "asc"]], limit: 1 },
      maxLimit: 2,
    });
    expect(() =>
      compileCollection(c, {
        from: songs,
        joins: [blobJoin],
        columns: { blob: (j) => j.bx.blob },
        db: recordingQueryDb().db,
      }),
    ).toThrow(/wire-encoded column/);
  });
});
