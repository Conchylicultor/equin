import { test, expect } from "bun:test";
import { pgTable } from "drizzle-orm/pg-core";
import { build } from "./storage";

test("string-list → text[]", () => {
  const t = pgTable("t", { c: build("c") });
  expect(t.c.getSQLType()).toBe("text[]");
});
