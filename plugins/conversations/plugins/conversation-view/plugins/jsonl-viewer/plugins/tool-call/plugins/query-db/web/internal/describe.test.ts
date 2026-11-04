import { describe, expect, test } from "bun:test";
import { cellText, compactSql, queryNote } from "./describe";

describe("query_db row words", () => {
  test("compactSql folds whitespace", () => {
    expect(
      compactSql(
        "select id, title\n  from tasks\n order by created_at desc limit 3; ",
      ),
    ).toBe("select id, title from tasks order by created_at desc limit 3;");
  });

  test("queryNote", () => {
    expect(queryNote({ shown: 0, total: 0 }, undefined)).toBe("· no rows");
    expect(queryNote({ shown: 1, total: 1 }, undefined)).toBe("· 1 row");
    expect(queryNote({ shown: 3, total: 3 }, "equin")).toBe("· 3 rows · equin");
    expect(queryNote({ shown: 200, total: 1431 }, undefined)).toBe(
      "· 200 of 1,431 rows",
    );
    expect(queryNote(undefined, "equin")).toBe("· equin");
    expect(queryNote(undefined, undefined)).toBeUndefined();
  });

  test("cellText", () => {
    expect(cellText(null)).toBe("null");
    expect(cellText("x")).toBe("x");
    expect(cellText(false)).toBe("false");
    expect(cellText({ kind: "symbol" })).toBe('{"kind":"symbol"}');
  });
});
