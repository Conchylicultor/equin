import { describe, expect, test } from "bun:test";
import { SQL_LABEL_MAX, sqlLabel } from "./sql-label";

describe("sqlLabel", () => {
  test("an IN list's length is not part of the label", () => {
    const one = sqlLabel(
      `select "id" from "reports" where "reports"."id" in ($1)`,
    );
    const three = sqlLabel(
      `select "id" from "reports" where "reports"."id" in ($1, $2, $3)`,
    );
    expect(one).toBe(`select "id" from "reports" where "reports"."id" in ($…)`);
    expect(three).toBe(one);
  });

  test("what follows a list is renumbered, so it reads the same at any length", () => {
    const short = sqlLabel(
      `select "op" from "w" where ("w"."op" in ($1, $2) and "w"."regime" = $3 and "w"."day" >= $4)`,
    );
    const long = sqlLabel(
      `select "op" from "w" where ("w"."op" in (${Array.from({ length: 59 }, (_, i) => `$${i + 1}`).join(", ")}) and "w"."regime" = $60 and "w"."day" >= $61)`,
    );
    expect(short).toBe(
      `select "op" from "w" where ("w"."op" in ($…) and "w"."regime" = $1 and "w"."day" >= $2)`,
    );
    expect(long).toBe(short);
  });

  test("two lists in one statement each collapse", () => {
    expect(
      sqlLabel(`where c in ($1, $2) and state in ($3, $4, $5) group by c`),
    ).toBe(`where c in ($…) and state in ($…) group by c`);
  });

  test("NOT IN, ARRAY[…] and casts", () => {
    expect(sqlLabel(`where x not in ($1, $2, $3)`)).toBe(`where x not in ($…)`);
    expect(
      sqlLabel(`where k = ANY(ARRAY[$1, $2]::text[]) and d = $3::jsonb`),
    ).toBe(`where k = ANY(ARRAY[$…]::text[]) and d = $1::jsonb`);
    expect(sqlLabel(`where k = ANY(ARRAY[$1])`)).toBe(
      `where k = ANY(ARRAY[$…])`,
    );
    expect(sqlLabel(`where k in ($1::text, $2::text)`)).toBe(`where k in ($…)`);
  });

  test("a multi-row insert is one label whatever its row count", () => {
    const one = sqlLabel(
      `insert into "t" ("a", "b") values ($1, $2) on conflict do nothing`,
    );
    const three = sqlLabel(
      `insert into "t" ("a", "b") values ($1, $2), ($3, $4), ($5, $6) on conflict do nothing`,
    );
    expect(one).toBe(
      `insert into "t" ("a", "b") values ($…) on conflict do nothing`,
    );
    expect(three).toBe(one);
  });

  test("a lone parenthesized placeholder outside a list keeps its number", () => {
    expect(sqlLabel(`select pg_advisory_xact_lock($7)`)).toBe(
      `select pg_advisory_xact_lock($1)`,
    );
    expect(sqlLabel(`select coalesce($1, 0) from t where a = $2`)).toBe(
      `select coalesce($1, 0) from t where a = $2`,
    );
  });

  test("a function's argument list of placeholders collapses like any list", () => {
    expect(sqlLabel(`select f($1, $2) where a = $3`)).toBe(
      `select f($…) where a = $1`,
    );
  });

  test("a repeated placeholder keeps one number", () => {
    expect(sqlLabel(`where a = $2 or b = $2 or c = $5`)).toBe(
      `where a = $1 or b = $1 or c = $2`,
    );
  });

  test("text without placeholders is unchanged, dollar quotes included", () => {
    const text = `DO $$ BEGIN PERFORM 1; END $$`;
    expect(sqlLabel(text)).toBe(text);
    expect(sqlLabel("select 1")).toBe("select 1");
  });

  test("the label is cut to the span label's length, after the lists collapse", () => {
    const ids = Array.from({ length: 400 }, (_, i) => `$${i + 1}`).join(", ");
    expect(sqlLabel(`select 1 where id in (${ids})`)).toBe(
      `select 1 where id in ($…)`,
    );
    expect(sqlLabel(`select '${"x".repeat(600)}'`).length).toBe(SQL_LABEL_MAX);
  });
});
