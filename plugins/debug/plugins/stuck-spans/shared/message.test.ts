import { describe, expect, test } from "bun:test";
import {
  describeChain,
  formatAge,
  stuckSpanMessage,
  stuckSpanSummaryLead,
} from "./message";

describe("formatAge", () => {
  test("seconds, minutes, hours", () => {
    expect(formatAge(45_000)).toBe("45 s");
    expect(formatAge(60_000)).toBe("1 min");
    expect(formatAge(187_000)).toBe("3 min");
    expect(formatAge(3_600_000)).toBe("1 h");
    expect(formatAge(4_200_000)).toBe("1 h 10 min");
  });
});

describe("stuckSpanMessage", () => {
  test("names the chain outermost first, ending at the stuck span", () => {
    expect(
      stuckSpanMessage({
        kind: "push",
        label: "conversations-gone-stats",
        ageMs: 187_000,
        ancestors: [
          { id: 10703, kind: "flush", label: "flushNotifies", ageMs: 187_010 },
        ],
      }),
    ).toBe(
      "An operation has been running for 3 min and has not finished: " +
        "flush flushNotifies → push conversations-gone-stats",
    );
  });

  test("runs of one operation found together read as one finding, counted", () => {
    const d = {
      kind: "sub",
      label: "reports.list:rows",
      ageMs: 95_000,
      ancestors: [],
    };
    expect(stuckSpanMessage({ ...d, runs: 121 })).toBe(
      "121 runs of an operation have been running for up to 1 min and have " +
        "not finished: sub reports.list:rows",
    );
    // One run (or a row filed before runs were grouped) reads as before.
    expect(stuckSpanMessage({ ...d, runs: 1 })).toBe(stuckSpanMessage(d));
    expect(stuckSpanMessage(d)).toBe(
      "An operation has been running for 1 min and has not finished: " +
        "sub reports.list:rows",
    );
  });

  test("a top-level span is its own chain", () => {
    expect(
      describeChain({ kind: "http", label: "GET /api/x", ancestors: [] }),
    ).toBe("http GET /api/x");
  });
});

describe("stuckSpanSummaryLead", () => {
  test("counts the runs of a grouped finding, and reads as before for one", () => {
    expect(stuckSpanSummaryLead({ ageMs: 95_000, runs: 121 })).toBe(
      "121 runs still running after 1 min:",
    );
    expect(stuckSpanSummaryLead({ ageMs: 187_000, runs: 1 })).toBe(
      "still running after 3 min:",
    );
    expect(stuckSpanSummaryLead({ ageMs: 187_000 })).toBe(
      "still running after 3 min:",
    );
  });
});

describe("a gate not admitting its waiters", () => {
  const gate = {
    layer: "read-admit",
    waitKind: "queue",
    waitedMs: 93_000,
    occupancy: { active: 6, queued: 121, max: 6 },
    holders: [{ label: 'host-fs.peek {"path":"/tmp"}', heldMs: 94_000 }],
    waiters: [
      { kind: "sub", label: "reports.list:rows", runs: 80 },
      { kind: "sub", label: "host-fs.peek", runs: 1 },
    ],
  };
  const d = {
    kind: "sub",
    label: "reports.list:rows",
    ageMs: 94_000,
    ancestors: [],
    runs: 81,
    gate,
  };

  test("the message names the gate and its holders, then who waits", () => {
    expect(stuckSpanMessage(d)).toBe(
      "81 operations have been queued on the read-admit gate for up to 1 min " +
        'without being admitted; it is held by host-fs.peek {"path":"/tmp"} ' +
        "(1 min). Waiting: sub reports.list:rows ×80, sub host-fs.peek",
    );
  });

  test("a gate naming no holder says so", () => {
    expect(
      stuckSpanMessage({ ...d, runs: 1, gate: { ...gate, holders: [] } }),
    ).toContain(
      "An operation has been queued on the read-admit gate for up to 1 min without being admitted; it is held by no named holder.",
    );
  });

  test("the summary lead counts the waiters", () => {
    expect(stuckSpanSummaryLead(d)).toBe(
      "81 waiting on read-admit for 1 min, held by:",
    );
  });
});

describe("a file call that has not returned", () => {
  const gate = {
    layer: "fs-readdir",
    waitKind: "io",
    waitedMs: 95_000,
    occupancy: null,
    holders: [],
    waiters: [{ kind: "sub", label: "host-fs.peek", runs: 1 }],
  };
  const d = {
    kind: "sub",
    label: "host-fs.peek",
    ageMs: 96_000,
    ancestors: [],
    runs: 1,
    gate,
  };

  test("the message names the filesystem layer, not a gate's holders", () => {
    expect(stuckSpanMessage(d)).toBe(
      "An operation has been waiting on the filesystem (fs-readdir) for up to " +
        "1 min: the file call has not returned. Waiting: sub host-fs.peek",
    );
  });

  test("the summary lead names no holder", () => {
    expect(stuckSpanSummaryLead(d)).toBe("1 waiting on fs-readdir for 1 min:");
  });
});
