import { describe, expect, test } from "bun:test";
import { createContext } from "../context";
import type { Verdict } from "../types";
import { postgresGuard } from "./postgres";

describe("postgres guard", () => {
  test("refuses a direct psql call", () => {
    const v = postgresGuard.check(
      { command: "psql -l" },
      createContext("/tmp"),
    ) as Verdict;
    expect(v.kind).toBe("deny");
  });
});
