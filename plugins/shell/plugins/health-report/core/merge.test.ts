import { describe, expect, it } from "bun:test";
import {
  foldQuietRows,
  mergeHealth,
  sortRows,
  verdictOf,
  type ReportedStatus,
} from "./merge";
import type { HealthStatus } from "./types";

const ok = (summary = "fine"): HealthStatus => ({ state: "ok", summary });
const attention = (summary = "look", transitioning = false): HealthStatus => ({
  state: "attention",
  summary,
  transitioning,
});
const critical = (summary = "broken"): HealthStatus => ({
  state: "critical",
  summary,
});
const notApplicable = (summary = "Not here."): HealthStatus => ({
  state: "not-applicable",
  summary,
});

describe("mergeHealth", () => {
  it("is ok, with nothing pending, over zero rows", () => {
    expect(mergeHealth([])).toEqual({
      state: "ok",
      count: 0,
      transitioning: false,
      pending: false,
    });
  });

  it("is ok when every row is ok", () => {
    expect(mergeHealth([ok(), ok()]).state).toBe("ok");
  });

  it("ranks critical over attention over unknown over ok", () => {
    expect(mergeHealth([ok(), attention(), critical()]).state).toBe("critical");
    expect(mergeHealth([ok(), attention(), { state: "unknown" }]).state).toBe(
      "attention",
    );
    expect(mergeHealth([ok(), { state: "unknown" }]).state).toBe("unknown");
  });

  it("lets an unreported row outrank ok, so green is never claimed early", () => {
    const merged = mergeHealth([ok(), undefined]);
    expect(merged.state).toBe("unknown");
    expect(merged.pending).toBe(true);
  });

  it("treats an unknown with a summary as unreadable, not pending", () => {
    const merged = mergeHealth([
      ok(),
      { state: "unknown", summary: "This check crashed" },
    ]);
    expect(merged.state).toBe("unknown");
    expect(merged.pending).toBe(false);
  });

  it("counts only attention and critical rows", () => {
    expect(
      mergeHealth([
        ok(),
        attention(),
        critical(),
        undefined,
        { state: "unknown" },
      ]).count,
    ).toBe(2);
  });

  it("leaves a not-applicable row out, as if it were not registered", () => {
    expect(mergeHealth([ok(), notApplicable()])).toEqual(mergeHealth([ok()]));
    expect(mergeHealth([notApplicable()])).toEqual(mergeHealth([]));
    expect(mergeHealth([attention(), notApplicable()]).count).toBe(1);
  });

  it("is transitioning when any row is transitioning", () => {
    expect(mergeHealth([ok(), attention("x", true)]).transitioning).toBe(true);
    expect(mergeHealth([ok(), attention("x", false)]).transitioning).toBe(
      false,
    );
  });
});

describe("verdictOf", () => {
  it("says all systems normal when everything is ok, and over zero rows", () => {
    expect(verdictOf([ok()])).toBe("All systems normal");
    expect(verdictOf([])).toBe("All systems normal");
  });

  it("says checking while a row has not reported", () => {
    expect(verdictOf([ok(), undefined])).toBe("Checking…");
    expect(verdictOf([ok(), { state: "unknown" }])).toBe("Checking…");
  });

  it("names the one unreadable row's reason once everything has reported", () => {
    expect(
      verdictOf([ok(), { state: "unknown", summary: "This check crashed" }]),
    ).toBe("This check crashed");
    expect(
      verdictOf([
        { state: "unknown", summary: "a" },
        { state: "unknown", summary: "b" },
      ]),
    ).toBe("2 checks can't be read right now");
  });

  it("uses the one non-green row's own summary", () => {
    expect(verdictOf([ok(), critical("Server disconnected")])).toBe(
      "Server disconnected",
    );
    expect(verdictOf([attention("Reconnecting…"), undefined])).toBe(
      "Reconnecting…",
    );
  });

  it("ignores not-applicable rows", () => {
    expect(verdictOf([ok(), notApplicable()])).toBe("All systems normal");
    expect(verdictOf([notApplicable(), notApplicable()])).toBe(
      "All systems normal",
    );
    expect(
      verdictOf([notApplicable(), { state: "unknown", summary: "crashed" }]),
    ).toBe("crashed");
  });

  it("counts several non-green rows", () => {
    expect(verdictOf([attention(), critical(), ok()])).toBe(
      "2 things need attention",
    );
  });
});

describe("sortRows", () => {
  interface R {
    id: string;
    kind: "status" | "info";
    order: number;
    status?: ReportedStatus;
  }
  const row = (
    id: string,
    kind: R["kind"],
    order: number,
    status?: ReportedStatus,
  ): R => ({ id, kind, order, status });
  const ids = (rows: R[]) => sortRows(rows, (r) => r.status).map((r) => r.id);

  it("puts info rows first, ordered by order", () => {
    expect(
      ids([
        row("s", "status", 0, ok()),
        row("i2", "info", 5),
        row("i1", "info", 1),
      ]),
    ).toEqual(["i1", "i2", "s"]);
  });

  it("orders status rows worst first", () => {
    expect(
      ids([
        row("ok", "status", 0, ok()),
        row("unknown", "status", 0, undefined),
        row("attention", "status", 0, attention()),
        row("critical", "status", 0, critical()),
        row("n/a", "status", -1, notApplicable()),
      ]),
    ).toEqual(["critical", "attention", "unknown", "ok", "n/a"]);
  });

  it("breaks severity ties by order, then keeps registration order", () => {
    expect(
      ids([
        row("b", "status", 20, ok()),
        row("a", "status", 10, ok()),
        row("c", "status", 20, ok()),
      ]),
    ).toEqual(["a", "b", "c"]);
  });

  it("does not mutate its input", () => {
    const input = [row("b", "status", 2, ok()), row("a", "status", 1, ok())];
    sortRows(input, (r) => r.status);
    expect(input.map((r) => r.id)).toEqual(["b", "a"]);
  });
});

describe("foldQuietRows", () => {
  type R = {
    id: string;
    kind: "status" | "info";
    order: number;
    status?: ReportedStatus;
    plain: boolean;
  };
  const row = (
    id: string,
    status: ReportedStatus,
    plain = true,
    kind: R["kind"] = "status",
  ): R => ({ id, kind, order: 0, status, plain });
  const shape = (rows: R[]) =>
    foldQuietRows(
      rows,
      (r) => r.status,
      (r) => r.plain,
    ).map((item) =>
      item.kind === "row" ? item.row.id : item.rows.map((r) => r.id),
    );

  it("folds every plain ok status row into one card where the first sorts", () => {
    expect(
      shape([
        row("info", undefined, true, "info"),
        row("bad", critical()),
        row("conn", ok()),
        row("queue", ok(), false),
        row("db", ok()),
        row("n/a", notApplicable()),
      ]),
    ).toEqual(["info", "bad", ["conn", "db"], "queue", "n/a"]);
  });

  it("leaves a plain row that is not ok on its own", () => {
    expect(
      shape([
        row("db", attention()),
        row("conn", ok()),
        row("reads", ok()),
        row("late", undefined),
      ]),
    ).toEqual(["db", ["conn", "reads"], "late"]);
  });

  it("folds nothing when fewer than two rows are quiet", () => {
    expect(shape([row("db", attention()), row("conn", ok())])).toEqual([
      "db",
      "conn",
    ]);
  });
});
