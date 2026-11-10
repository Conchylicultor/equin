import { describe, expect, test } from "bun:test";
import { planTriggerSync } from "./trigger-sync-plan";

const want = (jobName: string, jobWith: Record<string, unknown> = {}) => ({
  jobName,
  jobWith,
  oneShot: false,
  pageId: null,
  declared: true,
});
const stored = (id: string, row: Record<string, unknown>) => ({
  id,
  enabled: true,
  createdAt: new Date(0),
  ...row,
});

describe("planTriggerSync", () => {
  test("unchanged code plans no write, whatever the stored key order", () => {
    const wanted = [want("a.job", { x: 1, y: { b: 2, a: 1 } }), want("b.job")];
    const rows = [
      stored("1", { ...want("a.job"), jobWith: { y: { a: 1, b: 2 }, x: 1 } }),
      stored("2", want("b.job")),
    ];
    expect(planTriggerSync(rows, wanted)).toEqual({ deletes: [], inserts: [] });
  });

  test("a changed row is replaced, a removed one deleted, a new one inserted", () => {
    const rows = [
      stored("1", want("a.job", { x: 1 })),
      stored("2", want("gone.job")),
    ];
    const wanted = [want("a.job", { x: 2 }), want("new.job")];
    expect(planTriggerSync(rows, wanted)).toEqual({
      deletes: ["1", "2"],
      inserts: wanted,
    });
  });

  test("a runtime row of a declared job is not the declared row", () => {
    const rows = [stored("1", { ...want("a.job"), declared: false })];
    expect(planTriggerSync(rows, [want("a.job")])).toEqual({
      deletes: ["1"],
      inserts: [want("a.job")],
    });
  });

  test("a declared row disabled by hand is put back enabled", () => {
    const rows = [stored("1", { ...want("a.job"), enabled: false })];
    expect(planTriggerSync(rows, [want("a.job")])).toEqual({
      deletes: ["1"],
      inserts: [want("a.job")],
    });
  });

  test("duplicates pair one to one", () => {
    const rows = [stored("1", want("a.job")), stored("2", want("a.job"))];
    expect(planTriggerSync(rows, [want("a.job")])).toEqual({
      deletes: ["1"],
      inserts: [],
    });
  });

  test("a table nothing declares any more is emptied", () => {
    expect(planTriggerSync([stored("1", want("a.job"))], [])).toEqual({
      deletes: ["1"],
      inserts: [],
    });
  });
});
