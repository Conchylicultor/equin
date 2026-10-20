import { describe, expect, test } from "bun:test";
import { getTableConfig } from "drizzle-orm/pg-core";
import { _attempts } from "@plugins/tasks/plugins/tasks-core/server";
import { tasksTrack } from "../../server/internal/tables";
import { ATTEMPTS_TABLE, TRACK_TABLE } from "./checkout-track";

// The CLI lookup spells table and column names by hand (it cannot load the
// server barrels); these pin every one of them to the drizzle tables.
describe("checkoutTrack's hand-spelled names", () => {
  test("attempts", () => {
    expect(getTableConfig(_attempts).name).toBe(ATTEMPTS_TABLE.name);
    expect(_attempts.id.name).toBe(ATTEMPTS_TABLE.id);
    expect(_attempts.taskId.name).toBe(ATTEMPTS_TABLE.taskId);
  });

  test("tasks_ext_track", () => {
    const t = tasksTrack.table;
    expect(getTableConfig(t).name).toBe(TRACK_TABLE.name);
    expect(t.taskId.name).toBe(TRACK_TABLE.taskId);
    expect(t.track.name).toBe(TRACK_TABLE.track);
  });
});
