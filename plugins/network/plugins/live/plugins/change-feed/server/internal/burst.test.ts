import { describe, expect, test } from "bun:test";
import { createBurstRouter, type TxnEndProblem } from "./burst";
import type { FeedChange } from "./route-change";

const change = (table: string, xid?: string): FeedChange => ({
  source: "feed",
  table,
  op: "U",
  ids: ["1"],
  ...(xid !== undefined ? { xid } : {}),
  keys: null,
  unchanged: null,
});

// A router driven entirely by hand: the macrotask queue and the deadline timers
// are arrays the test runs, over a fake clock — firing a timer moves the clock to
// its due time, and `advance` lets time pass between changes.
function harness(deadlineMs = 2000) {
  let clock = 0;
  const macrotasks: Array<() => void> = [];
  const timers: Array<{ fn: () => void; ms: number; cancelled: boolean }> = [];
  const routed: string[] = [];
  const problems: TxnEndProblem[] = [];
  const router = createBurstRouter({
    route: (c) => routed.push(c.table),
    report: (p) => problems.push(p),
    defer: (fn) => macrotasks.push(fn),
    now: () => clock,
    arm: (fn, ms) => {
      const at = clock + ms;
      const t = {
        fn: () => {
          t.cancelled = true; // fired: no longer pending
          clock = Math.max(clock, at);
          fn();
        },
        ms,
        cancelled: false,
      };
      timers.push(t);
      return () => {
        t.cancelled = true;
      };
    },
    deadlineMs,
  });
  const runMacrotasks = (): void => {
    while (macrotasks.length > 0) macrotasks.shift()!();
  };
  // The timers still pending: neither cancelled nor fired.
  const live = () => timers.filter((t) => !t.cancelled);
  const advance = (ms: number): void => {
    clock += ms;
  };
  return {
    router,
    routed,
    problems,
    macrotasks,
    timers,
    live,
    runMacrotasks,
    advance,
  };
}

describe("createBurstRouter", () => {
  // The two NOTIFYs of one transaction, handed over by two socket reads: the
  // runtime's microtask drain must not run between them, or it ships the
  // transaction's ack before its second change reached the tuple.
  test("changes of an xid arriving across microtasks route together, in order, from one macrotask after its end", async () => {
    const turns: Array<[string, number]> = [];
    let turn = 0;
    const router = createBurstRouter({
      route: (c) => turns.push([c.table, turn]),
      report: (p) => {
        throw new Error(`unexpected report ${p.kind}`);
      },
    });
    router.change(change("hosts_ext", "900"));
    await Promise.resolve(); // a microtask drain would run here
    turn++;
    router.change(change("hosts", "900"));
    await new Promise<void>((r) => setImmediate(r)); // a later socket read
    turn++;
    expect(turns).toEqual([]); // held: no end yet
    router.end({ xid: "900", n: 2 });
    expect(turns).toEqual([]); // routed from a macrotask, not inline
    await new Promise<void>((r) => setImmediate(r));
    expect(turns).toEqual([
      ["hosts_ext", 2],
      ["hosts", 2],
    ]);
  });

  test("an xid is held until its end, however many macrotasks pass", () => {
    const h = harness();
    h.router.change(change("a", "1"));
    h.router.change(change("b", "1"));
    h.runMacrotasks();
    expect(h.routed).toEqual([]);
    expect(h.live()).toHaveLength(1); // one deadline per open xid
    h.router.end({ xid: "1", n: 2 });
    expect(h.live()).toHaveLength(0); // the end cancels it
    expect(h.macrotasks).toHaveLength(1);
    h.runMacrotasks();
    expect(h.routed).toEqual(["a", "b"]);
    expect(h.problems).toEqual([]);
  });

  test("a change with no xid routes on the next macrotask, without waiting for an open xid", () => {
    const h = harness();
    h.router.change(change("held", "5"));
    h.router.change(change("loose"));
    h.runMacrotasks();
    expect(h.routed).toEqual(["loose"]);
    h.router.end({ xid: "5", n: 1 });
    h.runMacrotasks();
    expect(h.routed).toEqual(["loose", "held"]);
    expect(h.problems).toEqual([]);
  });

  test("changes made ready together route from one macrotask", () => {
    const h = harness();
    h.router.change(change("a"));
    h.router.change(change("b", "2"));
    h.router.end({ xid: "2", n: 1 });
    h.router.change(change("c"));
    expect(h.macrotasks).toHaveLength(1);
    h.runMacrotasks();
    expect(h.routed).toEqual(["a", "b", "c"]);
  });

  test("fewer changes than n is no problem (Postgres folds identical payloads)", () => {
    const h = harness();
    h.router.change(change("a", "3"));
    h.router.end({ xid: "3", n: 4 });
    h.runMacrotasks();
    expect(h.routed).toEqual(["a"]);
    expect(h.problems).toEqual([]);
  });

  test("change-after-end: reported, then routed", () => {
    const h = harness();
    h.router.change(change("a", "7"));
    h.router.end({ xid: "7", n: 1 });
    h.router.change(change("late", "7"));
    expect(h.problems).toEqual([
      { kind: "change-after-end", xid: "7", table: "late" },
    ]);
    h.runMacrotasks();
    expect(h.routed).toEqual(["a", "late"]);
    expect(h.live()).toHaveLength(0); // an ended xid is never reopened
  });

  test("over-count: more changes than the end counted is reported; all route", () => {
    const h = harness();
    h.router.change(change("a", "8"));
    h.router.change(change("b", "8"));
    h.router.change(change("c", "8"));
    h.router.end({ xid: "8", n: 2 });
    expect(h.problems).toEqual([
      { kind: "over-count", xid: "8", routed: 3, n: 2 },
    ]);
    h.runMacrotasks();
    expect(h.routed).toEqual(["a", "b", "c"]);
  });

  test("interleaved: a new xid while an older one is open releases the older, which its end still counts", () => {
    const h = harness();
    h.router.change(change("old1", "10"));
    h.router.change(change("old2", "10"));
    h.router.change(change("new", "11"));
    expect(h.problems).toEqual([
      { kind: "interleaved", xid: "10", next: "11", held: 2 },
    ]);
    expect(h.live()).toHaveLength(1); // the older deadline cancelled, the newer armed
    h.runMacrotasks();
    expect(h.routed).toEqual(["old1", "old2"]); // the newer is still held
    // A late change of the released xid routes at once; its end counts it.
    h.router.change(change("old3", "10"));
    h.runMacrotasks();
    expect(h.routed).toEqual(["old1", "old2", "old3"]);
    h.router.end({ xid: "10", n: 2 });
    expect(h.problems[1]).toEqual({
      kind: "over-count",
      xid: "10",
      routed: 3,
      n: 2,
    });
    h.router.end({ xid: "11", n: 1 });
    h.runMacrotasks();
    expect(h.routed).toEqual(["old1", "old2", "old3", "new"]);
    expect(h.problems).toHaveLength(2);
  });

  test("txn-end-missing: past the one-shot deadline the xid is reported and released", () => {
    const h = harness(2000);
    h.router.change(change("a", "20"));
    h.router.change(change("b", "20"));
    expect(h.timers.map((t) => t.ms)).toEqual([2000]); // one timer, not a poll
    h.timers[0]!.fn();
    // Not yet: the socket gets one more turn (a stalled loop's waiting end).
    expect(h.problems).toEqual([]);
    h.runMacrotasks();
    expect(h.problems).toEqual([
      { kind: "txn-end-missing", xid: "20", held: 2, ms: 2000 },
    ]);
    h.runMacrotasks();
    expect(h.routed).toEqual(["a", "b"]);
    // Its end, arriving after all, checks the count and reports nothing more.
    h.router.end({ xid: "20", n: 2 });
    expect(h.problems).toHaveLength(1);
  });

  test("the deadline runs from the LAST change: a burst still streaming in is not cut off", () => {
    const h = harness(2000);
    h.router.change(change("a", "22"));
    h.advance(1500);
    h.router.change(change("b", "22")); // 1.5 s in: still arriving
    h.timers[0]!.fn(); // the first change's deadline (t = 2 s)
    h.runMacrotasks();
    expect(h.problems).toEqual([]);
    expect(h.routed).toEqual([]);
    // Re-armed for the remainder: 2 s after the last change.
    expect(h.live().map((t) => t.ms)).toEqual([1500]);
    h.router.end({ xid: "22", n: 2 });
    expect(h.live()).toHaveLength(0);
    h.runMacrotasks();
    expect(h.routed).toEqual(["a", "b"]);
    expect(h.problems).toEqual([]);
  });

  test("a re-armed deadline still fires once the xid goes quiet", () => {
    const h = harness(2000);
    h.router.change(change("a", "23"));
    h.advance(1000);
    h.router.change(change("b", "23"));
    h.timers[0]!.fn();
    h.live()[0]!.fn(); // quiet for 2 s since "b"
    h.runMacrotasks();
    expect(h.problems).toEqual([
      { kind: "txn-end-missing", xid: "23", held: 2, ms: 2000 },
    ]);
    h.runMacrotasks();
    expect(h.routed).toEqual(["a", "b"]);
  });

  test("an end read in the socket turn after the deadline fired still wins", () => {
    const h = harness();
    h.router.change(change("a", "21"));
    h.timers[0]!.fn(); // the timer phase runs first after a stall…
    h.router.end({ xid: "21", n: 1 }); // …then the poll phase reads the end
    h.runMacrotasks();
    expect(h.problems).toEqual([]);
    expect(h.routed).toEqual(["a"]);
  });

  test("after close (a retired socket) nothing is held or reported until reopen", () => {
    const h = harness();
    h.router.change(change("a", "31"));
    h.router.close(); // the socket dropped before 31's end
    h.router.change(change("b", "32")); // a straggler: routes, never held
    expect(h.live()).toHaveLength(0);
    h.runMacrotasks();
    expect(h.routed).toEqual(["a", "b"]);
    h.router.reopen(); // a new socket listens
    h.router.change(change("c", "33"));
    h.runMacrotasks();
    expect(h.routed).toEqual(["a", "b"]); // held again
    h.router.end({ xid: "33", n: 1 });
    h.runMacrotasks();
    expect(h.routed).toEqual(["a", "b", "c"]);
    expect(h.problems).toEqual([]);
  });

  test("close releases the open xid: nothing is dropped", () => {
    const h = harness();
    h.router.change(change("a", "30"));
    h.router.close();
    expect(h.live()).toHaveLength(0);
    h.runMacrotasks();
    expect(h.routed).toEqual(["a"]);
  });

  test("an end with no held changes reports nothing", () => {
    const h = harness();
    h.router.end({ xid: "40", n: 1 });
    h.runMacrotasks();
    expect(h.routed).toEqual([]);
    expect(h.problems).toEqual([]);
  });
});
