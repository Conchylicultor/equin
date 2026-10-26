import { describe, expect, test } from "bun:test";
import {
  TaskStatusSchema,
  type TaskStatus,
} from "@plugins/tasks/plugins/tasks-core/core";
import { SLOT_SETTLED_STATUSES } from "../../core";
import {
  AWAITING_LAUNCH_STATUS,
  catalogStatusMoved,
  FILED_CLOSED_STATUSES,
} from "./catalog-status";

const STATUSES = TaskStatusSchema.options;

// The catalog's three readings, spelled out independently of the module.
const reading = (s: TaskStatus) => ({
  closed: (FILED_CLOSED_STATUSES as readonly string[]).includes(s),
  settled: (SLOT_SETTLED_STATUSES as readonly string[]).includes(s),
  awaiting: s === AWAITING_LAUNCH_STATUS,
});

describe("catalogStatusMoved", () => {
  test("a running agent's turn moves nothing", () => {
    expect(catalogStatusMoved("in_progress", "need_action")).toBe(false);
    expect(catalogStatusMoved("need_action", "in_progress")).toBe(false);
    expect(catalogStatusMoved("in_progress", "in_progress_blocked")).toBe(
      false,
    );
    expect(catalogStatusMoved("blocked", "in_progress")).toBe(false);
  });

  test("closing a filing, freeing a slot and leaving `new` each move it", () => {
    expect(catalogStatusMoved("in_progress", "done")).toBe(true);
    expect(catalogStatusMoved("attempted", "dropped")).toBe(true);
    expect(catalogStatusMoved("need_action", "attempted")).toBe(true);
    expect(catalogStatusMoved("in_progress", "held")).toBe(true);
    expect(catalogStatusMoved("new", "in_progress")).toBe(true);
    expect(catalogStatusMoved("held", "new")).toBe(true);
  });

  test("over every pair: moved exactly when a reading differs", () => {
    for (const a of STATUSES) {
      for (const b of STATUSES) {
        const expected =
          JSON.stringify(reading(a)) !== JSON.stringify(reading(b));
        expect(`${a}→${b}:${catalogStatusMoved(a, b)}`).toBe(
          `${a}→${b}:${expected}`,
        );
      }
    }
  });
});
