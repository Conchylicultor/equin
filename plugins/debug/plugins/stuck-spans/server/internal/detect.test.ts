import { describe, expect, test } from "bun:test";
import {
  SPAN_KINDS,
  type SpanKind,
} from "@plugins/infra/plugins/runtime-profiler/core";
import {
  createStuckSpanWatcher,
  findStuckSpans,
  groupByOperation,
  type OpenSpan,
  type StuckSpanFinding,
} from "./detect";
import { STUCK_SPAN_POLICY } from "./policy";

// A fake flight window driven by an injected clock: each span has an open
// instant `t0`, and its age is `now - t0` — exactly how the recorder computes
// `ageMs` at capture. Tests move the clock and remove spans to simulate time
// passing and spans closing.
interface FakeSpan {
  id: number;
  parentId: number | null;
  kind: SpanKind;
  label: string;
  t0: number;
}

function fakeProcess() {
  let now = 0;
  const open = new Map<number, FakeSpan>();
  const handed: StuckSpanFinding[][] = [];
  const watcher = createStuckSpanWatcher({
    readOpen: (): OpenSpan[] =>
      [...open.values()].map((s) => ({
        id: s.id,
        parentId: s.parentId,
        kind: s.kind,
        label: s.label,
        ageMs: now - s.t0,
      })),
    onStuck: (findings) => {
      handed.push([...findings]);
    },
  });
  return {
    watcher,
    handed,
    open(s: Omit<FakeSpan, "t0">) {
      open.set(s.id, { ...s, t0: now });
    },
    close(id: number) {
      open.delete(id);
    },
    advance(ms: number) {
      now += ms;
    },
    /** Every span id handed to onStuck, in order. */
    reportedIds(): number[] {
      return handed.flat().map((f) => f.id);
    },
  };
}

const SEC = 1_000;

// Ages are derived from the real table, so a threshold change in `policy.ts`
// cannot break these tests for the wrong reason. The table's actual values are
// pinned once, in the STUCK_SPAN_POLICY suite at the bottom.
function thresholdOf(kind: SpanKind): number {
  const p = STUCK_SPAN_POLICY[kind];
  if (!p.watch) throw new Error(`${kind} is not a watched kind`);
  return p.thresholdMs;
}
const WATCHED_KINDS = SPAN_KINDS.filter((k) => STUCK_SPAN_POLICY[k].watch);
const LOADER = thresholdOf("loader");
const FLUSH = thresholdOf("flush");
const PUSH = thresholdOf("push");
const SUB = thresholdOf("sub");

describe("createStuckSpanWatcher", () => {
  test("files a span past its threshold once, not on every later tick", () => {
    const p = fakeProcess();
    p.open({ id: 7, parentId: null, kind: "loader", label: "tasks" });

    p.advance(LOADER - SEC);
    expect(p.watcher.tick()).toEqual([]);

    p.advance(SEC);
    const first = p.watcher.tick();
    expect(first.map((f) => f.id)).toEqual([7]);
    expect(first[0]).toMatchObject({
      kind: "loader",
      label: "tasks",
      ageMs: LOADER,
      thresholdMs: LOADER,
      ancestors: [],
    });

    // Still open and still stuck on the following ticks — never re-filed.
    for (let i = 0; i < 10; i++) {
      p.advance(15 * SEC);
      expect(p.watcher.tick()).toEqual([]);
    }
    expect(p.reportedIds()).toEqual([7]);
    expect(p.handed).toHaveLength(1);
  });

  test("does not call onStuck on a tick with nothing new", () => {
    const p = fakeProcess();
    p.open({ id: 1, parentId: null, kind: "flush", label: "flushNotifies" });
    p.advance(FLUSH - SEC);
    p.watcher.tick();
    expect(p.handed).toHaveLength(0);
  });

  test("each watched kind is filed at its own threshold, not a second before", () => {
    for (const [i, kind] of WATCHED_KINDS.entries()) {
      const p = fakeProcess();
      p.open({ id: i + 1, parentId: null, kind, label: `op-${kind}` });

      p.advance(thresholdOf(kind) - SEC);
      expect(p.watcher.tick()).toEqual([]);

      p.advance(SEC);
      const found = p.watcher.tick();
      expect(found.map((f) => f.id)).toEqual([i + 1]);
      expect(found[0]!.thresholdMs).toBe(thresholdOf(kind));
    }
  });

  test("never files job, bg or db spans, however old", () => {
    const p = fakeProcess();
    p.open({ id: 1, parentId: null, kind: "job", label: "backup.run" });
    p.open({ id: 2, parentId: null, kind: "bg", label: "change-feed:connect" });
    p.open({ id: 3, parentId: null, kind: "db", label: "select 1" });
    p.advance(60 * 60 * SEC);
    expect(p.watcher.tick()).toEqual([]);
    expect(p.handed).toHaveLength(0);
  });

  test("files a watched span running inside an excluded root, naming the root", () => {
    const p = fakeProcess();
    p.open({ id: 1, parentId: null, kind: "job", label: "tasks.push-ingest" });
    p.open({ id: 2, parentId: 1, kind: "loader", label: "attempts" });
    p.advance(LOADER + SEC);
    const [f] = p.watcher.tick();
    expect(f!.id).toBe(2);
    expect(f!.ancestors).toEqual([
      { id: 1, kind: "job", label: "tasks.push-ingest", ageMs: LOADER + SEC },
    ]);
  });

  test("reports only the deepest stuck span of a chain, with the chain above it", () => {
    // The 2026-09-11 shape: a flush and the push it is draining, opened
    // together, both far past their thresholds.
    const p = fakeProcess();
    p.open({ id: 10, parentId: 3, kind: "bg", label: "change-feed:connect" });
    p.open({ id: 10703, parentId: 10, kind: "flush", label: "flushNotifies" });
    p.open({
      id: 10705,
      parentId: 10703,
      kind: "push",
      label: "conversations-gone-stats",
    });

    p.advance(25 * 60 * SEC);
    const found = p.watcher.tick();
    expect(found).toHaveLength(1);
    expect(found[0]!.id).toBe(10705);
    // Outermost first; stops at id 3, which is not open (an orphan edge).
    expect(found[0]!.ancestors.map((a) => `${a.kind} ${a.label}`)).toEqual([
      "bg change-feed:connect",
      "flush flushNotifies",
    ]);
  });

  test("a stuck parent is filed on its own once its stuck child has finished", () => {
    const p = fakeProcess();
    p.open({ id: 1, parentId: null, kind: "flush", label: "flushNotifies" });
    p.open({ id: 2, parentId: 1, kind: "push", label: "tasks" });

    p.advance(Math.max(FLUSH, PUSH) + 10 * SEC);
    expect(p.watcher.tick().map((f) => f.id)).toEqual([2]);

    // The child fails (e.g. its query hit the deadline); the flush stays open.
    p.close(2);
    p.advance(15 * SEC);
    const next = p.watcher.tick();
    expect(next.map((f) => f.id)).toEqual([1]);
    expect(next[0]!.ancestors).toEqual([]);

    p.advance(15 * SEC);
    expect(p.watcher.tick()).toEqual([]);
    expect(p.reportedIds()).toEqual([2, 1]);
  });

  test("a young child does not hide its stuck parent", () => {
    // Only a STUCK descendant stands in for its ancestors.
    const p = fakeProcess();
    p.open({ id: 1, parentId: null, kind: "flush", label: "flushNotifies" });
    p.advance(FLUSH - 5 * SEC);
    p.open({ id: 2, parentId: 1, kind: "push", label: "tasks" });
    p.advance(5 * SEC);
    expect(p.watcher.tick().map((f) => f.id)).toEqual([1]);
  });

  test("forgets closed spans, and files a new run of the same operation again", () => {
    const p = fakeProcess();
    p.open({ id: 1, parentId: null, kind: "loader", label: "tasks" });
    p.open({ id: 2, parentId: null, kind: "loader", label: "attempts" });
    p.advance(LOADER);
    p.watcher.tick();
    expect(p.watcher.rememberedCount()).toBe(2);

    p.close(1);
    p.advance(15 * SEC);
    p.watcher.tick();
    expect(p.watcher.rememberedCount()).toBe(1);

    p.close(2);
    p.open({ id: 3, parentId: null, kind: "loader", label: "tasks" });
    p.advance(15 * SEC);
    p.watcher.tick();
    expect(p.watcher.rememberedCount()).toBe(0);

    p.advance(LOADER);
    const again = p.watcher.tick();
    expect(again.map((f) => [f.id, f.label])).toEqual([[3, "tasks"]]);
    expect(p.reportedIds()).toEqual([1, 2, 3]);
  });

  test("hands over findings oldest first, all in one call", () => {
    const p = fakeProcess();
    p.open({ id: 1, parentId: null, kind: "sub", label: "older" });
    p.advance(10 * SEC);
    p.open({ id: 2, parentId: null, kind: "loader", label: "younger" });
    p.advance(Math.max(SUB, LOADER));
    p.watcher.tick();
    expect(p.handed).toHaveLength(1);
    expect(p.handed[0]!.map((f) => f.label)).toEqual(["older", "younger"]);
  });

  test("reset forgets everything, so a restarted watchdog files again", () => {
    const p = fakeProcess();
    p.open({ id: 1, parentId: null, kind: "loader", label: "tasks" });
    p.advance(LOADER);
    p.watcher.tick();
    p.watcher.reset();
    expect(p.watcher.rememberedCount()).toBe(0);
    p.advance(15 * SEC);
    expect(p.watcher.tick().map((f) => f.id)).toEqual([1]);
  });
});

describe("findStuckSpans", () => {
  test("stops the ancestor walk at an edge that breaks parentId < id", () => {
    const open: OpenSpan[] = [
      {
        id: 5,
        parentId: 9,
        kind: "loader",
        label: "tasks",
        ageMs: LOADER + 10 * SEC,
      },
      { id: 9, parentId: 5, kind: "push", label: "tasks", ageMs: 10 * SEC },
    ];
    const [f] = findStuckSpans(open);
    expect(f!.id).toBe(5);
    expect(f!.ancestors).toEqual([]);
  });

  test("respects an injected policy", () => {
    const open: OpenSpan[] = [
      { id: 1, parentId: null, kind: "bg", label: "watch", ageMs: 2 * SEC },
      { id: 2, parentId: null, kind: "loader", label: "tasks", ageMs: 2 * SEC },
    ];
    const policy = {
      ...STUCK_SPAN_POLICY,
      bg: { watch: true, thresholdMs: 1 * SEC },
      loader: { watch: false, why: "test" },
    } as const;
    expect(findStuckSpans(open, policy).map((f) => f.id)).toEqual([1]);
  });
});

describe("STUCK_SPAN_POLICY", () => {
  // Which kinds are watched is the table's own decision (policy.ts, exhaustive
  // over SpanKind by type) — not restated here, so a new span kind needs one
  // edit, not two. What a test can hold is the shape of each decision.
  test("decides every span kind: a positive threshold, or a stated reason", () => {
    for (const kind of SPAN_KINDS) {
      const p = STUCK_SPAN_POLICY[kind];
      if (p.watch) expect(p.thresholdMs).toBeGreaterThan(0);
      else expect(p.why.trim().length).toBeGreaterThan(0);
    }
    expect(WATCHED_KINDS.length).toBeGreaterThan(0);
    expect(WATCHED_KINDS).toContain("http");
  });

  test("pins the real thresholds: http 120 s, the other watched kinds 90 s", () => {
    // The one place the table's values are spelled out. 90 s sits past the app
    // pool's 60 s query deadline on purpose (see policy.ts).
    expect(thresholdOf("http")).toBe(120 * SEC);
    for (const kind of WATCHED_KINDS.filter((k) => k !== "http"))
      expect(thresholdOf(kind)).toBe(90 * SEC);
  });
});

describe("groupByOperation", () => {
  test("runs of one operation found on one tick are one finding, led by the oldest", () => {
    const f = (id: number, label: string, ageMs: number) => ({
      id,
      kind: "sub" as const,
      label,
      ageMs,
      thresholdMs: 90_000,
      ancestors: [],
    });
    // Oldest first, as findStuckSpans sorts them.
    const groups = groupByOperation([
      f(1, "reports.list:rows", 300_000),
      f(2, "host-fs.peek", 200_000),
      f(3, "reports.list:rows", 100_000),
      f(4, "reports.list:rows", 95_000),
    ]);
    expect(groups.map((g) => [g.lead.id, g.lead.label, g.runs])).toEqual([
      [1, "reports.list:rows", 3],
      [2, "host-fs.peek", 1],
    ]);
  });
});
