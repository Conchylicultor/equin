/**
 * `serveCollection` over `ExprField`s (step 10 of
 * research/2026-10-01-global-scoped-change-routing-p5-p8-v2.md), without a
 * database: the recording `QueryDb` renders every query through drizzle's real
 * dialect, so each case reads the SQL a computed field puts in every shape.
 *
 * - an expression is projected, filtered, sorted (NULLS handling from its
 *   declared nullability), cut (cast to its declared `sqlType`) and grouped by
 *   — the SAME parenthesised SQL in every shape;
 * - its provenance is read off its SQL: the columns it reads are route
 *   columns, and an order over a lookup it reads makes the lookup membership;
 * - it reads the DEFAULTED wire columns (an extension column's COALESCE), and
 *   a server-only column only when declared;
 * - a `wire` codec encodes its value per row (NULL passes through), and makes
 *   the field unfilterable, as a `withWire` column's does;
 * - every misuse throws at compile (an undeclared table — the correlated
 *   subquery included —, a bad `sqlType`, an expression id, a nullable
 *   expression on a non-null field, a bare column) or does not type-check.
 *
 * Run: `./singularity test plugins/network/plugins/live`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { integer, pgTable, text, timestamp } from "drizzle-orm/pg-core";
import {
  expr,
  isExprField,
  type ExprField,
  type ExtensionJoin,
  type LookupJoin,
} from "@plugins/infra/plugins/query-resource/core";
import {
  compileWindowQuery,
  recordingQueryDb,
} from "@plugins/infra/plugins/query-resource/server/testing";
import { liveCollection } from "@plugins/network/plugins/live/core";
import { nullable } from "@plugins/fields/core";
import { dateField } from "@plugins/fields/plugins/date/plugins/config/core";
import { intField } from "@plugins/fields/plugins/int/plugins/config/core";

import { textField } from "@plugins/fields/plugins/text/plugins/config/core";
import { compileCollection } from "./serve-collection";

// ── The schema: a host, a defaulted 1:1 extension, an N:1 lookup ────────────

const songs = pgTable("xsongs", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  artistId: text("artist_id"),
  createdAt: integer("created_at").notNull(),
  // Not a wire column of the entity below.
  secret: text("secret"),
  // Never read by the collection.
  unread: text("unread"),
});
const playback = pgTable("xsongs_ext_playback", {
  parentId: text("parent_id").primaryKey(),
  plays: integer("plays").notNull().default(0),
});
const artists = pgTable("xartists", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});
// Never joined: an expression reading it must throw.
const servers = pgTable("xservers", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
});

/** An entity-shaped source: `secret` is server-only (not a wire column). */
const songsEntity = {
  name: "xsongs",
  table: songs,
  wireColumns: {
    id: songs.id,
    title: songs.title,
    artistId: songs.artistId,
    createdAt: songs.createdAt,
    unread: songs.unread,
  },
  schema: z.unknown(),
};

const playbackJoin: ExtensionJoin<"playback", typeof playback> = {
  kind: "extension",
  alias: "playback",
  table: playback,
  key: playback.parentId,
  parentKey: songs.id,
};
const artistJoin: LookupJoin<"artist", typeof artists> = {
  kind: "lookup",
  alias: "artist",
  table: artists,
  pk: artists.id,
  on: { from: "base", col: songs.artistId },
  required: false,
};

let seq = 0;
const SPEC = {
  fields: {
    id: textField({ label: "Id", filterable: false }),
    createdAt: intField({ label: "Created", filterable: false }),
    label: textField({ label: "Label" }),
    artistUpper: nullable(textField({ label: "Artist" })),
    playsPlusOne: intField({ label: "Plays + 1", filterable: false }),
  },
  id: "id",
  sortable: ["createdAt", "label", "artistUpper", "playsPlusOne"],
  default: { orderBy: [["createdAt", "desc"]], limit: 10 },
  maxLimit: 50,
} as const;
const collection = () => liveCollection(`test.live.expr-${seq++}`, SPEC);

const LABEL = `("xsongs"."title" || ' by ' || coalesce("artist"."name", '?'))`;
const UPPER = `(upper("artist"."name"))`;
const PLAYS = `(COALESCE("playback"."plays", $`;

function compile() {
  const c = collection();
  const recording = recordingQueryDb();
  const specs = compileCollection(c, {
    from: songs,
    joins: [playbackJoin, artistJoin],
    columns: {
      label: (j) =>
        expr(
          sql`${j.base.title} || ' by ' || coalesce(${j.artist.name}, '?')`,
          {
            decoder: String,
            sqlType: "text",
            notNull: true,
          },
        ),
      artistUpper: (j) =>
        expr(sql`upper(${j.artist.name})`, {
          decoder: String,
          sqlType: "text",
        }),
      playsPlusOne: (j) =>
        expr(sql`${j.playback.plays} + 1`, {
          decoder: Number,
          sqlType: "integer",
          notNull: true,
        }),
    },
    db: recording.db,
  });
  const window = compileWindowQuery(c.window, specs.window).serverOpts;
  const rows = compileWindowQuery(c.rows, specs.rows).serverOpts;
  return { c, specs, window, rows, groups: specs.groups, ...recording };
}

describe("serveCollection with expression fields — SQL", () => {
  test("projected in every shape, parenthesised, over the defaulted extension column", async () => {
    const { c, window, rows, calls } = compile();
    await window.loader(c.window.window.encode());
    const full = calls.at(-1)!.sql;
    expect(full).toContain(LABEL);
    expect(full).toContain(UPPER);
    // The extension's literal default: a host with no side row reads 0 + 1.
    expect(full).toContain(PLAYS);
    expect(calls.at(-1)!.params).toContain(0);
    await rows.loader(c.rows.point.encode(["s1"]));
    expect(calls.at(-1)!.sql).toContain(LABEL);
  });

  test("filtered through the filter language over the expression", async () => {
    const { c, window, calls } = compile();
    await window.loader(
      c.window.window.encode({ where: { label: { contains: "x" } } }),
    );
    const where = calls.at(-1)!.sql.split(" where ")[1]!;
    expect(where).toContain(LABEL);
  });

  test("sorted, and cut with NULL handling from its declared nullability, each operand cast to its sqlType", async () => {
    const { c, window, calls } = compile();
    const w = c.window.window;
    // A nullable expression: its cut's seek admits the NULLs ordered last.
    await window.loader(
      w.encode(
        { orderBy: [["artistUpper", "asc"]] },
        { after: JSON.stringify(["X", "s1"]) },
      ),
    );
    const nullable = calls.at(-1)!.sql;
    expect(nullable).toContain(`order by ${UPPER} ASC NULLS LAST`);
    expect(nullable).toContain(`${UPPER} IS NULL`);
    expect(nullable).toMatch(/\$\d+::text/);
    // The row key's part is the expression's own text.
    expect(nullable).toContain(`${UPPER}::text as "__row_key_0"`);
    // A NOT NULL one (declared `notNull`): no NULL arm, cast to `integer`.
    await window.loader(
      w.encode(
        { orderBy: [["playsPlusOne", "asc"]] },
        { after: JSON.stringify(["3", "s1"]) },
      ),
    );
    const notNull = calls.at(-1)!.sql.split(" where ")[1]!;
    expect(notNull).toMatch(/\$\d+::integer/);
    expect(notNull).not.toContain("IS NULL");
  });

  test("grouped by the expression", async () => {
    const { c, groups, calls } = compile();
    await groups.loader(c.groups.groups.encode({ groupBy: "label" }));
    const q = calls.at(-1)!.sql;
    // Selected as the value; grouped and ordered by its ordinal.
    expect(q).toContain(`select ${LABEL}, count(*)`);
    expect(q).toContain("group by 1 order by count(*) DESC, 1 ASC NULLS LAST");
    expect(q).toContain(`left join "xartists" "artist"`);
  });
});

describe("serveCollection with expression fields — routes", () => {
  test("the columns an expression reads are route columns; unread ones are not", () => {
    const { window } = compile();
    const routes = Object.fromEntries(
      window.routes!.routes.map((r) => [r.id, r.columns]),
    );
    expect(routes).toEqual({
      base: ["id", "title", "artist_id", "created_at"],
      playback: ["parent_id", "plays"],
      artist: ["id", "name"],
    });
  });

  test("an order over an expression reading a lookup makes the lookup membership, moved by what it reads", () => {
    const { c, window } = compile();
    const uses = (params: ReturnType<typeof c.window.window.encode>) =>
      Object.fromEntries(
        [...window.routes!.usesOf(params)].map(([id, u]) => [
          id,
          u.role === "membership" ? (u.moves ?? []) : "value",
        ]),
      );
    // Projected only: the lookup is a value read.
    expect(uses(c.window.window.encode())).toMatchObject({ artist: "value" });
    // Sorted by an expression over it: membership, moved by its name and key.
    expect(
      uses(c.window.window.encode({ orderBy: [["artistUpper", "desc"]] })),
    ).toMatchObject({ artist: ["id", "name"] });
    // Filtered by one reading the base and the lookup: both move it.
    expect(
      uses(c.window.window.encode({ where: { label: "x" } })),
    ).toMatchObject({
      base: expect.arrayContaining(["title", "artist_id"]),
      artist: ["id", "name"],
    });
  });
});

describe("serveCollection with expression fields — a wire codec", () => {
  const stamped = pgTable("xstamped_w", {
    id: text("id").primaryKey(),
    at: timestamp("at", { withTimezone: true }).notNull(),
  });
  const isoWire = { schema: z.string(), encode: (d: Date) => d.toISOString() };
  const wiredWindow = {
    id: "id",
    sortable: ["id"],
    default: { orderBy: [["id", "asc"]], limit: 10 },
    maxLimit: 50,
  } as const;
  const idField = textField({ label: "Id", filterable: false });
  const plainWired = () =>
    liveCollection(`test.live.expr-${seq++}`, {
      ...wiredWindow,
      fields: {
        id: idField,
        lastIso: nullable(textField({ label: "Last", filterable: false })),
      },
    });
  const filterableWired = () =>
    liveCollection(`test.live.expr-${seq++}`, {
      ...wiredWindow,
      fields: {
        id: idField,
        lastIso: nullable(textField({ label: "Last" })),
      },
    });
  const lastIso = (j: { base: { createdAt: unknown } }) =>
    expr(sql`to_timestamp(${j.base.createdAt})`, {
      decoder: stamped.at,
      sqlType: "timestamptz",
      wire: isoWire,
    });

  test("encodes the decoded value per row; a NULL passes through unencoded", async () => {
    const c = plainWired();
    const at = new Date("2026-10-01T12:00:00Z");
    // The fake answers decoded rows, as drizzle's builder would.
    const { db } = recordingQueryDb(() => [
      { id: "a", lastIso: at },
      { id: "b", lastIso: null },
    ]);
    const specs = compileCollection(c, {
      from: songs,
      columns: { lastIso: (j) => lastIso(j) },
      db,
    });
    const read = await compileWindowQuery(c.rows, specs.rows).serverOpts.loader(
      c.rows.point.encode(["a", "b"]),
    );
    expect(read).toEqual([
      { id: "a", lastIso: "2026-10-01T12:00:00.000Z" },
      { id: "b", lastIso: null },
    ]);
  });

  test("a wire-encoded expression cannot be filtered", () => {
    expect(() =>
      compileCollection(filterableWired(), {
        from: songs,
        columns: { lastIso: (j) => lastIso(j) },
        db: recordingQueryDb().db,
      }),
    ).toThrow(/"lastIso" is a wire-encoded column/);
  });

  test("the field's type is the WIRE type, not the stored one (tsc)", () => {
    const asDate = liveCollection(`test.live.expr-${seq++}`, {
      carry: {
        fields: { id: textField(), lastIso: nullable(dateField()) },
      },
      id: "id",
      sortable: ["id"],
      default: { orderBy: [["id", "asc"]], limit: 10 },
      maxLimit: 50,
    });
    const typeOnly = (): void => {
      // @ts-expect-error — the expression crosses the wire as a string.
      compileCollection(asDate, {
        from: songs,
        columns: { lastIso: (j) => lastIso(j) },
      });
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("serveCollection with expression fields — misuse", () => {
  const mini = () =>
    liveCollection(`test.live.expr-${seq++}`, {
      carry: { fields: { id: textField(), v: textField() } },
      id: "id",
      sortable: ["id"],
      default: { orderBy: [["id", "asc"]], limit: 10 },
      maxLimit: 50,
    });

  test("a relation that is neither the base nor a declared join throws — a correlated subquery included", () => {
    expect(() =>
      compileCollection(mini(), {
        from: songs,
        columns: {
          v: (j) =>
            expr(
              sql`(SELECT ${servers.name} FROM ${servers} WHERE ${servers.id} = ${j.base.artistId})`,
              { decoder: String, sqlType: "text", notNull: true },
            ),
        },
        db: recordingQueryDb().db,
      }),
    ).toThrow(/xservers.*neither the base table "xsongs" nor a declared join/);
  });

  test("an sqlType that is not a Postgres type name throws at declaration", () => {
    expect(() =>
      expr(sql`upper(${songs.title})`, {
        decoder: String,
        sqlType: "text; DROP TABLE x",
      }),
    ).toThrow(/is not a Postgres type name/);
  });

  test("a hand-built ExprField is not one: the brand only expr sets", () => {
    const forged = {
      kind: "expr" as const,
      sql: sql`upper(${songs.title})`,
      decoder: String,
      sqlType: "text); DROP TABLE x; --",
      notNull: true,
      serverOnly: [],
      wire: undefined,
    };
    expect(isExprField(forged)).toBe(false);
    expect(
      isExprField(
        expr(sql`upper(${songs.title})`, { decoder: String, sqlType: "text" }),
      ),
    ).toBe(true);
    // @ts-expect-error — the brand cannot be spelled outside expr.
    const typed: ExprField = forged;
    expect(typed).toBeDefined();
  });

  test("the id cannot be an expression", () => {
    expect(() =>
      compileCollection(mini(), {
        from: songs,
        columns: {
          id: (j) =>
            expr(sql`lower(${j.base.id})`, {
              decoder: String,
              sqlType: "text",
              notNull: true,
            }),
          v: (j) => j.base.title,
        },
        db: recordingQueryDb().db,
      }),
    ).toThrow(/the id "id" binds to an expression/);
  });

  test("a nullable expression on a non-null field throws (the runtime backstop of the type)", () => {
    expect(() =>
      // @ts-expect-error — `string | null` is not the field's `string` (the
      // overloaded call is where tsc reports a binding's return type).
      compileCollection(mini(), {
        from: songs,
        columns: {
          v: (j) =>
            expr(sql`upper(${j.base.artistId})`, {
              decoder: String,
              sqlType: "text",
            }),
        },
        db: recordingQueryDb().db,
      }),
    ).toThrow(
      /"v" is a computed read \(an expression or an aggregate\) that may read NULL/,
    );
  });

  test("a bare column — plain or defaulted — throws: bind a ColumnRef", () => {
    const bare = (build: "plain" | "defaulted") =>
      compileCollection(mini(), {
        from: songs,
        joins: [playbackJoin],
        columns: {
          v:
            build === "plain"
              ? (j) =>
                  expr(sql`${j.base.title}`, {
                    decoder: String,
                    sqlType: "text",
                    notNull: true,
                  })
              : (j) =>
                  expr(sql` ${j.playback.plays} `, {
                    decoder: String,
                    sqlType: "text",
                    notNull: true,
                  }),
        },
        db: recordingQueryDb().db,
      });
    expect(() => bare("plain")).toThrow(/is exactly one column/);
    expect(() => bare("defaulted")).toThrow(/is exactly one column/);
  });

  test("a server-only column is read only when declared in serverOnly — `j` does not offer it", () => {
    const build = (serverOnly: boolean) =>
      compileCollection(mini(), {
        from: songsEntity,
        columns: {
          // Named by the table's own column: `j.base` offers wire columns only.
          v: (j) =>
            expr(sql`coalesce(${songs.secret}, ${j.base.title})`, {
              decoder: String,
              sqlType: "text",
              notNull: true,
              ...(serverOnly ? { serverOnly: [songs.secret] } : {}),
            }),
        },
        db: recordingQueryDb().db,
      });
    expect(() => build(false)).toThrow(
      /reads "base"."secret", which is not a wire column of that relation/,
    );
    expect(() => build(true)).not.toThrow();
    const typeOnly = (): void => {
      compileCollection(mini(), {
        from: songsEntity,
        columns: {
          v: (j) =>
            // @ts-expect-error — `secret` is not a wire column of the entity.
            expr(sql`upper(${j.base.secret})`, {
              decoder: String,
              sqlType: "text",
              notNull: true,
            }),
        },
      });
    };
    expect(typeof typeOnly).toBe("function");
  });

  test("a declared server-only column of a table the compile does not read throws", () => {
    expect(() =>
      compileCollection(mini(), {
        from: songs,
        columns: {
          v: (j) =>
            expr(sql`upper(${j.base.title})`, {
              decoder: String,
              sqlType: "text",
              notNull: true,
              serverOnly: [servers.name],
            }),
        },
        db: recordingQueryDb().db,
      }),
    ).toThrow(/which is not the base table "xsongs"/);
  });

  test("the value type is the field's (tsc)", () => {
    const stamped = pgTable("xstamped", {
      id: text("id").primaryKey(),
      at: timestamp("at", { withTimezone: true }).notNull(),
    });
    // Each misuse is a type error; the bodies never run.
    // (tsc reports a binding's return type at the overloaded call.)
    const typeOnly = (): void => {
      // @ts-expect-error — a `number` decoder on a `string` field.
      compileCollection(mini(), {
        from: songs,
        columns: {
          v: (j) =>
            expr(sql`length(${j.base.title})`, {
              decoder: Number,
              sqlType: "integer",
              notNull: true,
            }),
        },
      });
      // @ts-expect-error — a Date-valued expression on a `string` field.
      compileCollection(mini(), {
        from: songs,
        columns: {
          v: (j) =>
            expr(sql`now() - ${j.base.createdAt}`, {
              decoder: stamped.at,
              sqlType: "timestamptz",
              notNull: true,
            }),
        },
      });
      compileCollection(mini(), {
        from: songs,
        columns: {
          v: (j) =>
            expr(
              // @ts-expect-error — `j` offers no undeclared relation.
              sql`upper(${j.undeclared.name})`,
              { decoder: String, sqlType: "text", notNull: true },
            ),
        },
      });
    };
    expect(typeof typeOnly).toBe("function");
  });
});
