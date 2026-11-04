import { describe, expect, test } from "bun:test";
import {
  ORIGIN_LABEL_MAX,
  parseSqlOrigin,
  tagSqlWithOrigin,
} from "./origin-comment";

describe("origin comment", () => {
  test("round-trips the statement and a label in the comment's alphabet", () => {
    const sql = 'select * from "tasks" where id = $1';
    const tagged = tagSqlWithOrigin(sql, "conversations.usage:sync");
    expect(tagged).toBe(
      '/* origin=conversations.usage:sync */ select * from "tasks" where id = $1',
    );
    expect(parseSqlOrigin(tagged)).toEqual({
      origin: "conversations.usage:sync",
      sql,
    });
  });

  test("a label can neither close its comment nor carry a read clause", () => {
    const tagged = tagSqlWithOrigin("select 1", 'GET /x */ drop "t" from y');
    expect(tagged.indexOf("*/")).toBe(tagged.lastIndexOf("*/"));
    expect(parseSqlOrigin(tagged).origin).toBe("GET_/x__/_drop__t__from_y");
    expect(parseSqlOrigin(tagged).sql).toBe("select 1");
  });

  test("cuts a long label", () => {
    const { origin } = parseSqlOrigin(
      tagSqlWithOrigin("select 1", "a".repeat(500)),
    );
    expect(origin).toHaveLength(ORIGIN_LABEL_MAX);
  });

  test("untagged text comes back whole", () => {
    expect(parseSqlOrigin("/* other */ select 1")).toEqual({
      origin: null,
      sql: "/* other */ select 1",
    });
  });
});
