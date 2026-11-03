import { describe, expect, test } from "bun:test";
import {
  aliasesNamedIn,
  describeAliases,
  undefinedColumnOf,
  type ReadAlias,
} from "./read-aliases";

const tasks: ReadAlias = {
  name: "tasks",
  view: "tasks_v",
  added: ["status", "active"],
};
const attempts: ReadAlias = { name: "attempts", view: "attempts_v", added: [] };

describe("aliasesNamedIn", () => {
  test("an unqualified or quoted name reaches its alias", () => {
    expect(aliasesNamedIn("select status from tasks t", [tasks])).toEqual([
      tasks,
    ]);
    expect(aliasesNamedIn('SELECT * FROM "tasks"', [tasks])).toEqual([tasks]);
  });

  test("a qualified name, the view itself or a longer name does not", () => {
    expect(aliasesNamedIn("select * from public.tasks", [tasks])).toEqual([]);
    expect(aliasesNamedIn("select * from tasks_v", [tasks])).toEqual([]);
    expect(aliasesNamedIn("select * from subtasks", [tasks])).toEqual([]);
  });

  test("only the aliases the query names", () => {
    expect(
      aliasesNamedIn("select * from attempts a", [tasks, attempts]),
    ).toEqual([attempts]);
  });
});

test("describeAliases names the view, its added columns and the table", () => {
  expect(describeAliases([tasks])).toBe(
    "`tasks` here is the view `tasks_v` (adds status, active); the physical table is `public.tasks`.",
  );
});

describe("undefinedColumnOf", () => {
  const pgError = (message: string, code: string) =>
    Object.assign(new Error(message), { code });

  test("reads the column of a qualified or quoted undefined-column error", () => {
    expect(
      undefinedColumnOf(pgError("column t.status does not exist", "42703")),
    ).toBe("status");
    expect(
      undefinedColumnOf(pgError('column "status" does not exist', "42703")),
    ).toBe("status");
  });

  test("any other error has none", () => {
    expect(
      undefinedColumnOf(pgError('relation "x" does not exist', "42P01")),
    ).toBeUndefined();
    expect(undefinedColumnOf("boom")).toBeUndefined();
  });
});
