import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { _prototypeState } from "../../server/internal/tables";
import { PROTOTYPE_STATE_TABLE } from "./deleted-prototypes";

// The CLI read spells table and column names by hand (it cannot load the
// server barrel); this pins every one of them to the drizzle table.
describe("readDeletedPrototypes' hand-spelled names", () => {
  test("prototype_state", () => {
    const t = _prototypeState;
    expect(getTableConfig(t).name).toBe(PROTOTYPE_STATE_TABLE.name);
    expect(t.id.name).toBe(PROTOTYPE_STATE_TABLE.id);
    expect(t.deletedAt.name).toBe(PROTOTYPE_STATE_TABLE.deletedAt);
  });
});
