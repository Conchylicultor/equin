/**
 * The behaviour under test is the diagnostic, not the parse.
 *
 * A `ZodError` already tells you a column is wrong. What cost a real incident
 * was not knowing *why* an array arrived as a string — so these tests pin the
 * three things the message must carry: the column, the Postgres type OID behind
 * it, and the cast that fixes it.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { parseRows } from "./parse-rows";
import { queryOne, queryResult, queryRows } from "./query";
import { SqlRowError } from "./errors";
import type { SqlQueryable, SqlResult } from "./types";

/** OID 1003 = `name[]`, the type `array_agg(pg_class.relname)` produces. */
const NAME_ARRAY_OID = 1003;
/** OID 20 = `int8`, which pg returns as a string by design. */
const INT8_OID = 20;

function result(rows: unknown[], fields?: SqlResult["fields"]): SqlResult {
  return { rows, rowCount: rows.length, fields };
}

function expectSqlRowError(run: () => unknown): SqlRowError {
  try {
    run();
  } catch (err) {
    if (err instanceof SqlRowError) return err;
    throw err;
  }
  throw new Error("expected a SqlRowError, but nothing was thrown");
}

describe("parseRows", () => {
  test("parses well-formed rows and hands back typed values", () => {
    const rows = parseRows(
      result([
        { name: "public", tables: ["a", "b"] },
        { name: "graphile_worker", tables: [] },
      ]),
      z.object({ name: z.string(), tables: z.array(z.string()) }),
      {},
    );

    expect(rows).toHaveLength(2);
    // Typed, not asserted: `.tables` is a real `string[]` here.
    expect(rows[0]?.tables.join("|")).toBe("a|b");
    expect(rows[1]?.name).toBe("graphile_worker");
  });

  test("an empty result is a legitimately-empty success", () => {
    expect(parseRows(result([]), z.object({ a: z.string() }), {})).toEqual([]);
  });

  test("the incident: `name[]` (OID 1003) arriving as its raw literal", () => {
    // The exact shape that produced a silently-empty database fork: pg has no
    // decoder for OID 1003, so `array_agg(relname)` came back as a string and
    // every array operation downstream misread it one character at a time.
    const raw = "{_private_jobs,migrations,graphile_worker}";

    const err = expectSqlRowError(() =>
      parseRows(
        result(
          [{ tables: raw }],
          [{ name: "tables", dataTypeID: NAME_ARRAY_OID }],
        ),
        z.object({ tables: z.array(z.string()) }),
        { sql: "SELECT array_agg(relname) AS tables FROM pg_class" },
      ),
    );

    expect(err.rowIndex).toBe(0);
    expect(err.column).toBe("tables");
    expect(err.dataTypeID).toBe(NAME_ARRAY_OID);
    expect(err.received).toBe(raw);

    expect(err.message).toContain('column "tables"');
    expect(err.message).toContain("expected array, received string");
    expect(err.message).toContain(raw);
    expect(err.message).toContain("OID 1003");
    expect(err.message).toContain("no type parser registered");
    expect(err.message).toContain("::text[]");
    expect(err.message).toContain("SELECT array_agg(relname)");
  });

  test("int8 (OID 20) arriving as a string fires the same hint", () => {
    const err = expectSqlRowError(() =>
      parseRows(
        result([{ bytes: "8192" }], [{ name: "bytes", dataTypeID: INT8_OID }]),
        z.object({ bytes: z.number() }),
        {},
      ),
    );

    expect(err.dataTypeID).toBe(INT8_OID);
    expect(err.received).toBe("8192");
    expect(err.message).toContain("expected number, received string");
    expect(err.message).toContain("OID 20");
    expect(err.message).toContain("Cast the column");
  });

  test("a string where a string was expected does NOT get the decoder hint", () => {
    const err = expectSqlRowError(() =>
      parseRows(
        result([{ name: 42 }], [{ name: "name", dataTypeID: 25 }]),
        z.object({ name: z.string() }),
        {},
      ),
    );

    expect(err.message).toContain("expected string, received number");
    expect(err.message).toContain("pg type: OID 25");
    expect(err.message).not.toContain("no type parser registered");
  });

  test("no `fields` on the result prints no OID line", () => {
    const err = expectSqlRowError(() =>
      parseRows(result([{ n: "x" }]), z.object({ n: z.number() }), {}),
    );

    expect(err.dataTypeID).toBeUndefined();
    expect(err.message).not.toContain("OID");
    expect(err.message).not.toContain("undefined");
    // The hint still fires — it is about the value, not the OID.
    expect(err.message).toContain("Cast the column");
  });

  test("no sql prints no sql line", () => {
    const err = expectSqlRowError(() =>
      parseRows(result([{ n: "x" }]), z.object({ n: z.string().uuid() }), {}),
    );
    expect(err.message).not.toContain("sql:");
  });

  test("a nested issue path is walked to the value that actually arrived", () => {
    const err = expectSqlRowError(() =>
      parseRows(
        result([{ meta: { a: 42 } }], [{ name: "meta", dataTypeID: 3802 }]),
        z.object({ meta: z.object({ a: z.string() }) }),
        {},
      ),
    );

    expect(err.column).toBe("meta");
    expect(err.received).toBe(42);
    expect(err.message).toContain("value: 42");
  });

  test("every row is parsed, so a later row's mismatch is reported with its index", () => {
    const rows = [
      { at: "2026-08-23" },
      { at: "2026-08-24" },
      { at: "2026-08-25" },
      { at: null },
    ];

    const err = expectSqlRowError(() =>
      parseRows(
        result(rows, [{ name: "at", dataTypeID: 25 }]),
        z.object({ at: z.string() }),
        {},
      ),
    );

    expect(err.rowIndex).toBe(3);
    expect(err.received).toBeNull();
    expect(err.message).toContain("row 3 of a SQL result");
    expect(err.message).toContain("expected string, received null");
  });

  test("a non-ZodError thrown from inside a schema propagates untouched", () => {
    const boom = new Error("transform blew up");
    const schema = z.object({ a: z.string() }).transform(() => {
      throw boom;
    });

    expect(() => parseRows(result([{ a: "x" }]), schema, {})).toThrow(boom);
  });

  test("the value is truncated, and a long sql is collapsed and truncated", () => {
    const long = "x".repeat(1000);
    const err = expectSqlRowError(() =>
      parseRows(result([{ v: long }]), z.object({ v: z.number() }), {
        sql: `SELECT\n   ${"y".repeat(1000)}`,
      }),
    );

    const valueLine = err.message
      .split("\n")
      .find((l) => l.startsWith("  value:"));
    const sqlLine = err.message.split("\n").find((l) => l.startsWith("  sql:"));
    expect(valueLine?.length).toBeLessThan(260);
    expect(sqlLine?.length).toBeLessThan(460);
    expect(sqlLine).toContain("SELECT y");
  });
});

/** A hand-built client, so the front doors are tested without a database. */
function fakeClient(rows: unknown[]): SqlQueryable {
  return {
    query: (_sql: string, _params?: unknown[]) =>
      Promise.resolve(result(rows, [{ name: "id", dataTypeID: 23 }])),
  };
}

const IdRow = z.object({ id: z.number() });

describe("queryResult", () => {
  test("passes fields and rowCount through, with the rows still parsed", async () => {
    const parsed = await queryResult(fakeClient([{ id: 1 }, { id: 2 }]), {
      sql: "SELECT id FROM t",
      row: IdRow,
    });

    expect(parsed.rows.map((r) => r.id)).toEqual([1, 2]);
    expect(parsed.rowCount).toBe(2);
    expect(parsed.fields).toEqual([{ name: "id", dataTypeID: 23 }]);
  });

  test("a driver that supplied no fields yields `[]`, not an absent case", async () => {
    const client: SqlQueryable = {
      query: () => Promise.resolve({ rows: [{ id: 1 }], rowCount: 1 }),
    };
    const parsed = await queryResult(client, { sql: "SELECT 1", row: IdRow });

    expect(parsed.fields).toEqual([]);
    expect(parsed.rows).toEqual([{ id: 1 }]);
  });

  test("is not an escape hatch — a bad row still throws", async () => {
    const promise = queryResult(fakeClient([{ id: "1" }]), {
      sql: "SELECT id FROM t",
      row: IdRow,
    });
    expect(promise).rejects.toBeInstanceOf(SqlRowError);
  });

  test("a multi-statement answer (pg's array of results) throws, naming the count", () => {
    // What pg's simple-query protocol hands back for `SET …; SELECT …`.
    const client: SqlQueryable = {
      query: () => Promise.resolve([result([]), result([{ id: 1 }])]),
    };
    const promise = queryResult(client, {
      sql: "SET LOCAL search_path = public; SELECT 1 AS id",
      row: IdRow,
    });
    expect(promise).rejects.toThrow(/expected one SQL statement, got 2/);
  });
});

describe("queryRows / queryOne", () => {
  test("queryRows parses what the client returned", async () => {
    const rows = await queryRows(fakeClient([{ id: 1 }, { id: 2 }]), {
      sql: "SELECT id FROM t",
      row: IdRow,
    });
    expect(rows.map((r) => r.id)).toEqual([1, 2]);
  });

  test("queryOne returns the single row", async () => {
    const row = await queryOne(fakeClient([{ id: 7 }]), {
      sql: "SELECT id FROM t WHERE id = $1",
      params: [7],
      row: IdRow,
    });
    expect(row.id).toBe(7);
  });

  test("queryOne throws on zero rows, quoting the count and the sql", async () => {
    const promise = queryOne(fakeClient([]), {
      sql: "SELECT id FROM t WHERE id = $1",
      params: [7],
      row: IdRow,
    });
    expect(promise).rejects.toThrow(/got 0[\s\S]*SELECT id FROM t/);
  });

  test("queryOne throws on two rows", async () => {
    const promise = queryOne(fakeClient([{ id: 1 }, { id: 2 }]), {
      sql: "SELECT id FROM t",
      row: IdRow,
    });
    expect(promise).rejects.toThrow(/got 2/);
  });

  test("a bad row still fails through the front door", async () => {
    const promise = queryRows(fakeClient([{ id: "1" }]), {
      sql: "SELECT id FROM t",
      row: IdRow,
    });
    expect(promise).rejects.toBeInstanceOf(SqlRowError);
  });
});
