import { describe, expect, test } from "bun:test";
import { pgTable, text } from "drizzle-orm/pg-core";
import { findCascadeFk, markCascadeBounded } from "./assert-cascade";
import { getTableGrowthBounds } from "./growth-bounds";

// Throwaway physical schemas (no live DB) — only the drizzle FK metadata matters.
const owner = pgTable("ac_owner", {
  id: text("id").primaryKey(),
});
const otherOwner = pgTable("ac_other_owner", {
  id: text("id").primaryKey(),
});

// A child with an FK onDelete:"cascade" to `owner`.
const cascadingChild = pgTable("ac_cascading_child", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").references(() => owner.id, { onDelete: "cascade" }),
});
// A child with an FK to `owner` but onDelete:"no action".
const noActionChild = pgTable("ac_no_action_child", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").references(() => owner.id, { onDelete: "no action" }),
});
// A child cascading to a DIFFERENT owner.
const wrongOwnerChild = pgTable("ac_wrong_owner_child", {
  id: text("id").primaryKey(),
  ownerId: text("owner_id").references(() => otherOwner.id, { onDelete: "cascade" }),
});
// A child with no FKs at all.
const noFkChild = pgTable("ac_no_fk_child", {
  id: text("id").primaryKey(),
});

describe("findCascadeFk (pure)", () => {
  test("accepts a cascading FK to the named owner", () => {
    const fk = findCascadeFk(cascadingChild, owner);
    expect(fk).not.toBeNull();
    expect(fk!.onDelete).toBe("cascade");
  });

  test("rejects onDelete: 'no action'", () => {
    expect(findCascadeFk(noActionChild, owner)).toBeNull();
  });

  test("rejects a cascading FK to a different owner", () => {
    expect(findCascadeFk(wrongOwnerChild, owner)).toBeNull();
  });

  test("rejects a table with no FKs", () => {
    expect(findCascadeFk(noFkChild, owner)).toBeNull();
  });
});

describe("markCascadeBounded", () => {
  test("records a cascade bound on a valid cascading FK", () => {
    markCascadeBounded(cascadingChild, owner);
    expect(getTableGrowthBounds().get("ac_cascading_child")).toEqual({
      kind: "cascade",
      owner: "ac_owner",
    });
  });

  test("throws naming the table, the owner, and the FKs found", () => {
    let message = "";
    try {
      markCascadeBounded(noActionChild, owner);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("ac_no_action_child"); // table
    expect(message).toContain("ac_owner"); // owner
    expect(message).toContain("no action"); // the FK actually found
  });

  test("throws for a table with no FKs, listing (none)", () => {
    expect(() => markCascadeBounded(noFkChild, owner)).toThrow(/\(none\)/);
  });
});
