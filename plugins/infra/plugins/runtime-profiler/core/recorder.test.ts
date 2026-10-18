// bun:test suite for the recorder's wait-propagation decomposition. The core
// stays pure — the AsyncLocalStorage runtime and the deterministic clock are
// injected HERE, exactly the way server/internal/install.ts does at boot.
import { beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  __contribute,
  __pushBand,
  WAIT_BAND_CAP,
  captureFlightWindow,
  chargeWait,
  currentOriginClass,
  getRuntimeProfile,
  getSelfMeter,
  installBackgroundLaneRuntime,
  installClock,
  installLoaderReadSetSink,
  installProfilingSuppressionRuntime,
  installSpanContextRuntime,
  onSlowSpan,
  readGateGauges,
  recordEntrySpan,
  recordReadTables,
  recordSpan,
  registerGateGauge,
  resetRuntimeProfile,
  runInBackgroundLane,
  runWithoutProfiling,
  type Aggregate,
  type EntryContext,
  type FlightSpan,
  type FlightWindow,
  type SlowSpan,
  type SpanKind,
  type Track,
  type WaitBand,
} from "./recorder";

// The cross-layer wait union a positioned-band consumer derives: the total time
// the span was blocked on ANY layer, so it must union overlapping bands from
// different layers (two layers can stall at once). This is the reference the
// recorder's `waitMs` scalar must equal — computed here the slow, obvious way.
function crossLayerUnion(bands: readonly { t0: number; t1: number }[]): number {
  if (bands.length === 0) return 0;
  const sorted = [...bands].sort((a, b) => a.t0 - b.t0);
  let total = 0;
  let lo = sorted[0]!.t0;
  let hi = sorted[0]!.t1;
  for (let i = 1; i < sorted.length; i++) {
    const b = sorted[i]!;
    if (b.t0 <= hi) {
      if (b.t1 > hi) hi = b.t1;
    } else {
      total += hi - lo;
      lo = b.t0;
      hi = b.t1;
    }
  }
  return total + (hi - lo);
}

// Real ALS runtime so context propagates across awaits like in production.
const als = new AsyncLocalStorage<EntryContext>();
installSpanContextRuntime({
  run: (ctx, fn) => als.run(ctx, fn),
  current: () => als.getStore(),
});

// The background-lane override, installed exactly as server/internal/install.ts does.
const backgroundLaneAls = new AsyncLocalStorage<true>();
installBackgroundLaneRuntime({
  run: (fn) => backgroundLaneAls.run(true, fn),
  active: () => backgroundLaneAls.getStore() === true,
});

// The suppression scope, installed exactly as server/internal/install.ts does —
// the self-meter's nesting detection rides on `suppressed()`, so the tests need
// the real ALS propagation across awaits.
const suppressAls = new AsyncLocalStorage<true>();
installProfilingSuppressionRuntime({
  run: (fn) => suppressAls.run(true, fn),
  suppressed: () => suppressAls.getStore() === true,
});

// The loader read-set sink, installed the way server/internal/install.ts wires
// server-core's runtime-owned read-set: every flush lands here, in order.
let readSetFlushes: Array<{ label: string; tables: string[] }> = [];
installLoaderReadSetSink((label, tables) => {
  readSetFlushes.push({ label, tables: [...tables].sort() });
});

let fakeNow = 0;

beforeEach(() => {
  fakeNow = 0;
  installClock(() => fakeNow);
  resetRuntimeProfile();
  readSetFlushes = [];
});

function agg(kind: SpanKind, label: string): Aggregate {
  const found = getRuntimeProfile().aggregates[kind].find(
    (a) => a.label === label,
  );
  if (!found) throw new Error(`no ${kind} aggregate for ${label}`);
  return found;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

describe("wait propagation", () => {
  test("a gate wait deep in a nested entry chain lands in every open ancestor", async () => {
    await recordEntrySpan("flush", "flushNotifies", async () => {
      await recordEntrySpan("push", "res:tasks", async () => {
        await recordEntrySpan("loader", "tasks", async () => {
          fakeNow = 50;
          chargeWait("loader-acquire", 50); // interval [0, 50]
          fakeNow = 60;
        });
      });
      fakeNow = 70;
    });

    const flush = agg("flush", "flushNotifies");
    const push = agg("push", "res:tasks");
    const loader = agg("loader", "tasks");
    for (const a of [flush, push, loader]) {
      expect(a.waits).toEqual({ "loader-acquire": 50 });
      expect(a.waitTotalMs).toBe(50);
    }
    // loader: wall 60 = wait 50 + self 10, no children.
    expect(loader.totalMs).toBe(60);
    expect(loader.childTotalMs).toBe(0);
    expect(loader.selfTotalMs).toBe(10);
    // push: wall 60, child (loader exec [0,60]) covers everything → self 0.
    expect(push.totalMs).toBe(60);
    expect(push.childTotalMs).toBe(60);
    expect(push.selfTotalMs).toBe(0);
    // flush: wall 70, child = push exec [0,60]; busy = wait ∪ child = [0,60].
    expect(flush.totalMs).toBe(70);
    expect(flush.childTotalMs).toBe(60);
    expect(flush.selfTotalMs).toBe(10);
  });

  test("concurrent children's overlapping waits union on the parent (< sum, ≤ wall)", async () => {
    await recordEntrySpan("flush", "f", async () => {
      const gateA = deferred();
      const gateB = deferred();
      const childA = recordEntrySpan("loader", "a", async () => {
        await gateA.promise;
        chargeWait("gate", 30); // resumes at now=40 → interval [10, 40]
      });
      const childB = recordEntrySpan("loader", "b", async () => {
        await gateB.promise;
        chargeWait("gate", 30); // resumes at now=50 → interval [20, 50]
      });
      fakeNow = 40;
      gateA.resolve();
      await childA;
      fakeNow = 50;
      gateB.resolve();
      await childB;
      fakeNow = 60;
    });

    const flush = agg("flush", "f");
    // Union of [10,40] ∪ [20,50] = [10,50] = 40ms — NOT the 60ms sum, and ≤ 60ms wall.
    expect(flush.waitTotalMs).toBe(40);
    expect(flush.waits).toEqual({ gate: 40 });
    expect(flush.totalMs).toBe(60);
    // Child executions [0,40] ∪ [0,50]: the streaming union sees [0,40] first
    // with an empty frontier → 40, then [0,50] adds the [40,50] tail → 50.
    expect(flush.childTotalMs).toBe(50);
    // busy = waits ∪ child execs under the end-ordered streaming union: the
    // waits cover [10,50]; child A's [0,40] arrives when the frontier is
    // already at 40, so its [0,10] head is (conservatively) not re-counted —
    // busy 40, self 20 (≥ the true 10, never negative).
    expect(flush.selfTotalMs).toBe(20);
    // Each child individually: wall 40/50, wait 30, self = remainder.
    expect(agg("loader", "a").waitTotalMs).toBe(30);
    expect(agg("loader", "a").selfTotalMs).toBe(10);
    expect(agg("loader", "b").waitTotalMs).toBe(30);
    expect(agg("loader", "b").selfTotalMs).toBe(20);
  });
});

describe("decomposition coherence", () => {
  test("leaf entry: waitMs + selfMs == wall; composite: waitMs + selfMs ≤ wall, childMs ≈ wall", async () => {
    await recordEntrySpan("loader", "leaf", async () => {
      fakeNow = 30;
      chargeWait("db-acquire", 30);
      fakeNow = 100;
    });
    const leaf = agg("loader", "leaf");
    expect(leaf.waitTotalMs + leaf.selfTotalMs).toBe(leaf.totalMs); // 30 + 70 = 100

    await recordEntrySpan("flush", "composite", async () => {
      await recordEntrySpan("push", "p", async () => {
        fakeNow = 150;
      });
      fakeNow = 160;
    });
    const composite = agg("flush", "composite");
    expect(composite.totalMs).toBe(60);
    expect(composite.childTotalMs).toBe(50); // push exec [100, 150]
    expect(composite.selfTotalMs).toBe(10);
    expect(composite.waitTotalMs + composite.selfTotalMs).toBeLessThanOrEqual(
      composite.totalMs,
    );
    expect(composite.selfTotalMs).toBeGreaterThanOrEqual(0);
  });
});

describe("closed-ancestor safety", () => {
  test("a detached child finishing after its parent closed leaves the parent's record untouched", async () => {
    const gate = deferred();
    let child!: Promise<void>;
    await recordEntrySpan("push", "p", async () => {
      child = recordEntrySpan("loader", "detached", async () => {
        await gate.promise;
        chargeWait("gate", 50); // parent already closed by now
      });
      fakeNow = 10;
    });
    // Parent recorded at wall 10 with nothing charged yet.
    fakeNow = 100;
    gate.resolve();
    await child;

    const push = agg("push", "p");
    expect(push.totalMs).toBe(10);
    expect(push.waitTotalMs).toBe(0);
    expect(push.childTotalMs).toBe(0);
    expect(push.selfTotalMs).toBe(10);
    expect(push.waits).toBeUndefined();
    // The detached child still records itself fully: wait [50,100], wall 100.
    const detached = agg("loader", "detached");
    expect(detached.totalMs).toBe(100);
    expect(detached.waitTotalMs).toBe(50);
    expect(detached.selfTotalMs).toBe(50);
  });

  test("recordReadTables on a closed context is a no-op (the entry already flushed its read-set)", async () => {
    // A detached, fire-and-forget continuation still carries its loader's
    // EntryContext across the await (ALS semantics — same as the detached-child
    // test above), so it records a late read AFTER the loader entry closed and
    // flushed its tables into the index.
    let captured!: EntryContext;
    const gate = deferred();
    let late!: Promise<void>;
    await recordEntrySpan("loader", "l", () => {
      captured = als.getStore()!;
      recordReadTables(["real_table"]);
      late = (async () => {
        await gate.promise;
        recordReadTables(["late_table"]); // the context is closed by now
      })();
    });

    // The entry flushed exactly its one real read at finish.
    expect(readSetFlushes).toEqual([{ label: "l", tables: ["real_table"] }]);
    expect(captured.closed).toBe(true);

    // Let the late write land on the (now closed) context — it must be dropped.
    gate.resolve();
    await late;

    // Neither the closed context's own set nor the flushed index gained the
    // late table: the append was a structural no-op, not a silently-lost write.
    expect(captured.tables && [...captured.tables]).toEqual(["real_table"]);
    expect(readSetFlushes).toEqual([{ label: "l", tables: ["real_table"] }]);
  });

  test("a closed intermediate ancestor is skipped, an open grandparent still charged", async () => {
    // `chargeWait` skips a closed ancestor with `continue`, not `break`, so it
    // charges the OPEN grandparent above a closed parent — the exact case that
    // makes reconstructing bands from a subtree walk wrong (the closed parent
    // would get a phantom band). Assert the closed parent carries no band while
    // the open grandparent and the detached child both do.
    const gate = deferred();
    let child!: Promise<void>;
    let mid!: FlightWindow;
    await recordEntrySpan("flush", "f", async () => {
      await recordEntrySpan("push", "p", async () => {
        // Detached child: started under p but NOT awaited, so p closes first.
        child = recordEntrySpan("loader", "l", async () => {
          await gate.promise;
          chargeWait("gate", 30); // now=50 → [20,50]; p closed at 40, f still open
        });
        fakeNow = 40; // p closes here, before the child's gate resolves
      });
      fakeNow = 50;
      gate.resolve();
      await child;
      // f still open; p completed at 40 (wall 40 ≥ 5ms ring floor); l completed at 50.
      mid = captureFlightWindow({ windowStartMs: 0 });
      fakeNow = 60;
    });

    // The wait skipped the closed push and landed on the open flush.
    const flush = agg("flush", "f");
    expect(flush.waits).toEqual({ gate: 30 });
    expect(flush.waitTotalMs).toBe(30);
    // The loader's exec interval [0,50] also skipped the closed push and
    // charged the flush's childUnion (nearest OPEN ancestor).
    expect(flush.childTotalMs).toBe(50);
    const pushAgg = agg("push", "p");
    expect(pushAgg.waitTotalMs).toBe(0);
    expect(pushAgg.waits).toBeUndefined();

    // Bands: the open grandparent and the completed child both carry [20,50];
    // the closed intermediate waited for nothing and carries no band.
    const f = mid.open.find((s) => s.label === "f")!;
    const p = mid.completed.find((s) => s.label === "p")!;
    const l = mid.completed.find((s) => s.label === "l")!;
    expect(f.waitBands).toEqual([{ layer: "gate", t0: 20, t1: 50 }]);
    expect(l.waitBands).toEqual([{ layer: "gate", t0: 20, t1: 50 }]);
    expect(p.waitMs).toBe(0);
    expect(p.waitBands).toBeUndefined();
  });
});

describe("rolling max", () => {
  test("recentMaxMs decays past the window; maxMs/maxAgeMs retain the aged peak", () => {
    fakeNow = 1000;
    recordSpan("db", "q", 500);
    let a = agg("db", "q");
    expect(a.maxMs).toBe(500);
    expect(a.recentMaxMs).toBe(500);
    expect(a.maxAgeMs).toBe(0);

    // ~6 idle minutes later: the spike's bucket has left the 5-min window.
    fakeNow = 1000 + 360_000;
    a = agg("db", "q");
    expect(a.recentMaxMs).toBe(0);
    expect(a.maxMs).toBe(500);
    expect(a.maxAgeMs).toBe(360_000);

    // A new small record becomes the live recent max; the aged peak persists.
    recordSpan("db", "q", 100);
    a = agg("db", "q");
    expect(a.recentMaxMs).toBe(100);
    expect(a.maxMs).toBe(500);
    expect(a.maxAgeMs).toBe(360_000);
  });
});

describe("chargeWait fallbacks and markers", () => {
  test("no active entry → standalone db [layer] span", () => {
    chargeWait("loader-acquire", 25);
    const a = agg("db", "[loader-acquire]");
    expect(a.count).toBe(1);
    expect(a.totalMs).toBe(25);
    // Leaf-shaped record: the wait IS the span, decomposition defaults apply.
    expect(a.waitTotalMs).toBe(0);
    expect(a.selfTotalMs).toBe(25);
  });

  test("zero-ms marker creates the layer key with 0 and leaves waitMs at 0", async () => {
    await recordEntrySpan("loader", "l", async () => {
      fakeNow = 10;
      chargeWait("git-memo-hit", 0);
      fakeNow = 20;
    });
    const a = agg("loader", "l");
    expect(a.waits).toEqual({ "git-memo-hit": 0 });
    expect(a.waitTotalMs).toBe(0);
    expect(a.selfTotalMs).toBe(20);
  });
});

describe("origin class", () => {
  // `currentOriginClass` reads the ROOT of the entry chain, not the innermost
  // entry — the whole point is that a `loader` says nothing about *why* it runs.
  test("a loader under flush → push is background (the cascade's root is flush)", async () => {
    let seen: unknown;
    await recordEntrySpan("flush", "flushNotifies", async () => {
      await recordEntrySpan("push", "res:tasks", async () => {
        await recordEntrySpan("loader", "tasks", () => {
          seen = currentOriginClass();
        });
      });
    });
    expect(seen).toBe("background");
  });

  test("the same loader under a sub-ack root is interactive", async () => {
    let seen: unknown;
    await recordEntrySpan("sub", "res:tasks", async () => {
      await recordEntrySpan("loader", "tasks", () => {
        seen = currentOriginClass();
      });
    });
    expect(seen).toBe("interactive");
  });

  test("the same loader under an http root is interactive", async () => {
    let seen: unknown;
    await recordEntrySpan("http", "GET /api/boot-snapshot", async () => {
      await recordEntrySpan("loader", "tasks", () => {
        seen = currentOriginClass();
      });
    });
    expect(seen).toBe("interactive");
  });

  test("a bare root maps through the table: job → background, sub → interactive", async () => {
    let job: unknown;
    let sub: unknown;
    await recordEntrySpan("job", "reindex", () => {
      job = currentOriginClass();
    });
    await recordEntrySpan("sub", "res:tasks", () => {
      sub = currentOriginClass();
    });
    expect(job).toBe("background");
    expect(sub).toBe("interactive");
  });

  test("no enclosing entry → undefined (boot/migrations stay ungated)", () => {
    expect(currentOriginClass()).toBeUndefined();
  });

  test("a detached continuation keeps its root's origin after the root closed", async () => {
    // The walk deliberately does NOT skip closed ancestors: it only reads `kind`,
    // and a fire-and-forget continuation spawned by a flush is still flush-origin
    // work long after the flush entry recorded itself.
    const gate = deferred();
    let detached!: Promise<unknown>;
    await recordEntrySpan("flush", "f", () => {
      detached = (async () => {
        await gate.promise;
        return currentOriginClass();
      })();
    });
    gate.resolve();
    expect(await detached).toBe("background");
  });

  test("runInBackgroundLane overrides an interactive origin chain", async () => {
    let inside: unknown;
    let after: unknown;
    await recordEntrySpan("http", "POST /api/tasks", async () => {
      await recordEntrySpan("loader", "tasks", () => {
        runInBackgroundLane(() => {
          inside = currentOriginClass();
        });
        // The scope is exactly the callback: the enclosing request is human
        // again the moment it returns.
        after = currentOriginClass();
      });
    });
    expect(inside).toBe("background");
    expect(after).toBe("interactive");
  });

  test("runInBackgroundLane with no entry at all is background, not undefined", () => {
    expect(runInBackgroundLane(() => currentOriginClass())).toBe("background");
  });

  test("the lane survives an await inside the scope (a transaction's whole life)", async () => {
    // `runInBackgroundLane` returns whatever `fn` returns — including a promise —
    // so ALS keeps the awaited DB work of an observability write in scope.
    const seen = await runInBackgroundLane(async () => {
      await Promise.resolve();
      return currentOriginClass();
    });
    expect(seen).toBe("background");
  });
});

describe("per-instance span identity", () => {
  // Every completed span ≥5ms lands in the flight ring, which is the only place
  // ids are observable — the aggregates group by label, by design.
  function completedByLabel(): Map<string, FlightSpan> {
    const w = captureFlightWindow({ windowStartMs: 0 });
    return new Map(w.completed.map((s) => [s.label, s]));
  }

  test("ids are unique and increase monotonically across entry and leaf spans", async () => {
    await recordEntrySpan("http", "e", async () => {
      fakeNow = 10;
      recordSpan("db", "q1", 10); // leaf: mints at record time
      fakeNow = 20;
    });
    recordSpan("db", "q2", 10);

    const spans = completedByLabel();
    const e = spans.get("e")!;
    const q1 = spans.get("q1")!;
    const q2 = spans.get("q2")!;
    // The entry mints at OPEN, so it precedes the leaf it encloses even though
    // it records last.
    expect(e.id).toBeLessThan(q1.id);
    expect(q1.id).toBeLessThan(q2.id);
    expect(new Set([e.id, q1.id, q2.id]).size).toBe(3);
  });

  test("resetRuntimeProfile does NOT restart the counter (live contexts keep their ids)", async () => {
    await recordEntrySpan("loader", "before", async () => {
      fakeNow = 10;
    });
    const before = completedByLabel().get("before")!.id;

    resetRuntimeProfile();
    fakeNow = 100;
    await recordEntrySpan("loader", "after", async () => {
      fakeNow = 110;
    });
    expect(completedByLabel().get("after")!.id).toBeGreaterThan(before);
  });

  test("a child entry's parentId is its enclosing entry's id; a top-level entry has none", async () => {
    await recordEntrySpan("flush", "f", async () => {
      fakeNow = 10;
      await recordEntrySpan("push", "p", async () => {
        fakeNow = 20;
      });
      fakeNow = 30;
    });

    const spans = completedByLabel();
    const f = spans.get("f")!;
    const p = spans.get("p")!;
    expect(f.parentId).toBeNull();
    expect(p.parentId).toBe(f.id);
    // A parent always OPENS first, so the edge always points backwards — this
    // is what makes the reconstructed tree acyclic by construction.
    expect(p.parentId!).toBeLessThan(p.id);
  });

  test("a leaf db span inside a loader entry carries that loader's id as parentId", async () => {
    await recordEntrySpan("loader", "tasks", async () => {
      fakeNow = 10;
      recordSpan("db", "select tasks", 10);
      fakeNow = 20;
    });

    const spans = completedByLabel();
    expect(spans.get("select tasks")!.parentId).toBe(spans.get("tasks")!.id);
  });

  test("two concurrent same-label loaders are distinct instances under their own parents", async () => {
    const gate = deferred();
    const parents = ["p1", "p2"].map((label) =>
      recordEntrySpan("push", label, async () => {
        await recordEntrySpan("loader", "tasks", async () => {
          await gate.promise;
        });
      }),
    );
    fakeNow = 20;
    gate.resolve();
    await Promise.all(parents);

    const w = captureFlightWindow({ windowStartMs: 0 });
    const loaders = w.completed.filter((s) => s.label === "tasks");
    const p1 = w.completed.find((s) => s.label === "p1")!;
    const p2 = w.completed.find((s) => s.label === "p2")!;
    // Same {kind,label} — indistinguishable before ids existed. Now each names
    // the exact push instance it ran under.
    expect(loaders).toHaveLength(2);
    expect(new Set(loaders.map((s) => s.parentId))).toEqual(
      new Set([p1.id, p2.id]),
    );
  });
});

describe("flight recorder — ancestor closure", () => {
  test("open spans carry id/parentId matching the live EntryContext chain", async () => {
    await recordEntrySpan("flush", "f", async () => {
      const outer = als.getStore()!;
      await recordEntrySpan("loader", "l", async () => {
        const inner = als.getStore()!;
        fakeNow = 30;
        const w = captureFlightWindow({ windowStartMs: 0 });
        const of = w.open.find((s) => s.label === "f")!;
        const ol = w.open.find((s) => s.label === "l")!;
        expect(of.id).toBe(outer.id);
        expect(of.parentId).toBeNull();
        expect(ol.id).toBe(inner.id);
        expect(ol.parentId).toBe(outer.id);
      });
    });
  });

  test("a truncated open set never strands an OPEN ancestor", async () => {
    const gate = deferred();
    const live: EntryContext[] = [];
    // flush → push → three concurrent loaders: five entries, all registered
    // synchronously before the first await, all open at capture time.
    const run = recordEntrySpan("flush", "f", async () => {
      live.push(als.getStore()!);
      await recordEntrySpan("push", "p", async () => {
        live.push(als.getStore()!);
        await Promise.all(
          ["l1", "l2", "l3"].map((label) =>
            recordEntrySpan("loader", label, async () => {
              live.push(als.getStore()!);
              await gate.promise;
            }),
          ),
        );
      });
    });

    const w = captureFlightWindow({ windowStartMs: 0, maxOpen: 2 });
    expect(w.open.length).toBeGreaterThanOrEqual(2); // maxOpen is a SOFT cap
    const returned = new Set(w.open.map((s) => s.id));
    const byId = new Map(live.map((ctx) => [ctx.id, ctx]));
    for (const span of w.open) {
      if (span.parentId === null) continue;
      const parent = byId.get(span.parentId);
      // A hole in the middle of a chain would silently reparent a subtree. The
      // parent must be in the window, unless it is not an open ancestor at all
      // (closed, or never an entry) — a legitimate orphan.
      const isOpenAncestor = parent !== undefined && !parent.closed;
      expect(returned.has(span.parentId) || !isOpenAncestor).toBe(true);
    }
    // Uncapped: the whole live chain comes back, exactly linked.
    const full = captureFlightWindow({ windowStartMs: 0 });
    expect(full.open).toHaveLength(5);
    const flush = full.open.find((s) => s.label === "f")!;
    const push = full.open.find((s) => s.label === "p")!;
    expect(push.parentId).toBe(flush.id);
    for (const label of ["l1", "l2", "l3"]) {
      expect(full.open.find((s) => s.label === label)!.parentId).toBe(push.id);
    }

    gate.resolve();
    await run;
  });
});

describe("flight recorder — ring write precedes the notify loop", () => {
  test("a slow-span handler capturing synchronously sees the tripping span in completed", async () => {
    let captured: FlightWindow | undefined;
    let tripId: number | undefined;
    // The trip span is deregistered from `openEntries` before record() runs, so
    // only the ring can carry it. If the ring write came after this notify, the
    // span would be absent from its own trace and `child` would be an orphan.
    const sub = onSlowSpan(
      (span) => {
        if (span.label !== "trip") return;
        tripId = span.id;
        captured = captureFlightWindow({ windowStartMs: 0 });
      },
      { thresholdMs: 10 },
    );
    try {
      await recordEntrySpan("http", "trip", async () => {
        await recordEntrySpan("loader", "child", async () => {
          fakeNow = 20;
        });
        fakeNow = 30;
      });
    } finally {
      sub.dispose();
    }

    if (tripId === undefined)
      throw new Error("onSlowSpan never fired for the trip span");
    const trip = captured!.completed.find((s) => s.id === tripId);
    expect(trip?.label).toBe("trip");
    expect(captured!.completed.find((s) => s.label === "child")!.parentId).toBe(
      tripId,
    );
  });
});

describe("flight recorder — open-entry registry", () => {
  test("capture mid-flight lists nested open entries with parentId/ageMs; empty after completion", async () => {
    let mid!: FlightWindow;
    await recordEntrySpan("flush", "f", async () => {
      await recordEntrySpan("loader", "l", async () => {
        fakeNow = 30;
        mid = captureFlightWindow({ windowStartMs: 0 });
      });
    });

    expect(mid.atMs).toBe(30);
    expect(mid.open).toHaveLength(2);
    const loader = mid.open.find((s) => s.kind === "loader")!;
    expect(loader.label).toBe("l");
    expect(loader.t0).toBe(0);
    expect(loader.t1).toBeNull();
    expect(loader.ageMs).toBe(30);
    expect(loader.waits).toBeUndefined(); // only materialized when non-empty
    const flush = mid.open.find((s) => s.kind === "flush")!;
    expect(flush.parentId).toBeNull();
    expect(loader.parentId).toBe(flush.id);
    // Both entries closed → deregistered.
    expect(captureFlightWindow({ windowStartMs: 0 }).open).toHaveLength(0);
  });

  test("a throwing entry is still removed from the open registry", async () => {
    let thrown: unknown;
    try {
      await recordEntrySpan("loader", "boom", async () => {
        fakeNow = 10;
        throw new Error("boom");
      });
    } catch (err) {
      thrown = err;
    }
    expect((thrown as Error).message).toBe("boom");
    expect(captureFlightWindow({ windowStartMs: 0 }).open).toHaveLength(0);
  });

  test("an open span's live wait unions appear in the capture", async () => {
    await recordEntrySpan("loader", "l", async () => {
      fakeNow = 40;
      chargeWait("db-acquire", 40); // interval [0, 40]
      fakeNow = 50;
      const w = captureFlightWindow({ windowStartMs: 0 });
      const span = w.open[0]!;
      expect(span.waits).toEqual({ "db-acquire": 40 });
      expect(span.waitMs).toBe(40);
      // selfMs mid-flight: age 50 − busy 40 (coverage so far).
      expect(span.selfMs).toBe(10);
    });
  });
});

describe("flight recorder — completed ring", () => {
  test("a finished span ≥5ms appears with correct t0/t1 and immediate parent; a sub-5ms span does not", async () => {
    await recordEntrySpan("push", "p", async () => {
      await recordEntrySpan("loader", "slow", async () => {
        fakeNow = 20;
      });
      await recordEntrySpan("loader", "fast", async () => {
        fakeNow = 22; // 2ms — below the 5ms floor
      });
    });

    const completed = captureFlightWindow({ windowStartMs: 0 }).completed;
    // Newest→oldest: the enclosing push recorded last.
    expect(completed.map((s) => s.label)).toEqual(["p", "slow"]);
    const push = completed[0]!;
    const slow = completed[1]!;
    expect(slow.t0).toBe(0);
    expect(slow.t1).toBe(20);
    expect(slow.ageMs).toBe(20);
    expect(slow.parentId).toBe(push.id);
    expect(push.parentId).toBeNull();
  });

  test("windowStartMs excludes spans completed before the window", async () => {
    await recordEntrySpan("loader", "old", async () => {
      fakeNow = 10;
    });
    fakeNow = 100;
    await recordEntrySpan("loader", "recent", async () => {
      fakeNow = 110;
    });
    const completed = captureFlightWindow({ windowStartMs: 50 }).completed;
    expect(completed.map((s) => s.label)).toEqual(["recent"]);
  });
});

describe("flight recorder — caps", () => {
  test("maxOpen and maxCompleted are respected; completed comes back newest first", async () => {
    for (const label of ["a", "b", "c"]) {
      const start = fakeNow;
      await recordEntrySpan("loader", label, async () => {
        fakeNow = start + 10;
      });
    }
    const w = captureFlightWindow({ windowStartMs: 0, maxCompleted: 2 });
    expect(w.completed.map((s) => s.label)).toEqual(["c", "b"]);

    // Three concurrently-open entries (registered synchronously before the
    // first await), capped at 2.
    const gate = deferred();
    const runs = ["x", "y", "z"].map((label) =>
      recordEntrySpan("loader", label, async () => {
        await gate.promise;
      }),
    );
    expect(
      captureFlightWindow({ windowStartMs: 0, maxOpen: 2 }).open,
    ).toHaveLength(2);
    gate.resolve();
    await Promise.all(runs);
  });
});

describe("flight recorder — gate gauges", () => {
  test("a registered gauge is read; duplicate layer registration throws", () => {
    registerGateGauge("test-gate", () => ({ active: 2, queued: 5, max: 4 }));
    expect(readGateGauges()["test-gate"]).toEqual({
      active: 2,
      queued: 5,
      max: 4,
    });
    expect(() =>
      registerGateGauge("test-gate", () => ({ active: 0, queued: 0, max: 0 })),
    ).toThrow("duplicate layer");
  });

  test("resetRuntimeProfile clears the flight ring but keeps registered gauges", async () => {
    registerGateGauge("reset-gate", () => ({ active: 1, queued: 0, max: 1 }));
    await recordEntrySpan("loader", "l", async () => {
      fakeNow = 10;
    });
    expect(captureFlightWindow({ windowStartMs: 0 }).completed).toHaveLength(1);

    resetRuntimeProfile();
    expect(captureFlightWindow({ windowStartMs: 0 }).completed).toHaveLength(0);
    expect(readGateGauges()["reset-gate"]).toEqual({
      active: 1,
      queued: 0,
      max: 1,
    });
  });
});

describe("loader read-set capture — handed to the installed sink", () => {
  // Mirrors the DB pool chokepoint: recordReadTables fires INSIDE the loader entry.
  async function runLoader(key: string, tables: string[]): Promise<void> {
    await recordEntrySpan("loader", key, () => {
      recordReadTables(tables);
    });
  }

  test("each loader run flushes its own tables once, at finish", async () => {
    await runLoader("attempts", ["attempts_v", "conversations_v"]);
    await runLoader("attempts", ["attempts_v"]);
    expect(readSetFlushes).toEqual([
      { label: "attempts", tables: ["attempts_v", "conversations_v"] },
      { label: "attempts", tables: ["attempts_v"] },
    ]);
  });

  test("a run that reads no tables flushes nothing; a non-loader entry never flushes", async () => {
    await recordEntrySpan("loader", "p", () => {});
    await recordEntrySpan("http", "GET /x", () => {
      recordReadTables(["tasks"]);
    });
    expect(readSetFlushes).toEqual([]);
  });

  // The read-set is runtime state, not profile data: a kill-switched profiler
  // records no span, yet the route drift guard still needs every loader's tables.
  test("captures under the SINGULARITY_PROFILING=0 kill-switch, which drops the span itself", async () => {
    const prior = process.env.SINGULARITY_PROFILING;
    process.env.SINGULARITY_PROFILING = "0";
    try {
      await runLoader("killed", ["tasks"]);
    } finally {
      if (prior === undefined) delete process.env.SINGULARITY_PROFILING;
      else process.env.SINGULARITY_PROFILING = prior;
    }
    expect(readSetFlushes).toEqual([{ label: "killed", tables: ["tasks"] }]);
    expect(
      getRuntimeProfile().aggregates.loader.find((a) => a.label === "killed"),
    ).toBeUndefined();
  });

  // Suppression is an ATTRIBUTION rule, not a profiling one: observability
  // writes issued inside a loader's context are not that loader's dependencies.
  test("reads issued under runWithoutProfiling are never attributed to the enclosing loader", async () => {
    await recordEntrySpan("loader", "l", async () => {
      recordReadTables(["real_table"]);
      await runWithoutProfiling(async () => {
        recordReadTables(["reports"]);
      });
    });
    expect(readSetFlushes).toEqual([{ label: "l", tables: ["real_table"] }]);
  });
});

describe("__contribute streaming union", () => {
  test("clips the interval start to the floor, returning the covered ms", () => {
    const t: Track = { unionMs: 0, prevEnd: 0 };
    expect(__contribute(t, -5, 10, 0)).toBe(10);
    expect(t).toEqual({ unionMs: 10, prevEnd: 10 });
    const t2: Track = { unionMs: 0, prevEnd: 4 };
    expect(__contribute(t2, 0, 10, 4)).toBe(6);
    expect(t2).toEqual({ unionMs: 6, prevEnd: 10 });
  });

  test("a fully-covered interval contributes 0 and keeps the frontier", () => {
    const t: Track = { unionMs: 10, prevEnd: 10 };
    expect(__contribute(t, 2, 8, 0)).toBe(0);
    expect(t).toEqual({ unionMs: 10, prevEnd: 10 });
  });

  test("out-of-order ends never overcount; partial overlap adds only the tail", () => {
    const t: Track = { unionMs: 10, prevEnd: 10 };
    expect(__contribute(t, 5, 15, 0)).toBe(5); // overlaps [5,10] → adds only [10,15]
    expect(t).toEqual({ unionMs: 15, prevEnd: 15 });
    expect(__contribute(t, 0, 12, 0)).toBe(0); // end behind the frontier → 0
    expect(t).toEqual({ unionMs: 15, prevEnd: 15 });
  });
});

describe("__pushBand tail-merge and drop-smallest", () => {
  test("extends the last band when the new slice touches it; pushes across a gap", () => {
    const bands: WaitBand[] = [];
    __pushBand(bands, "g", 0, 10, 12);
    __pushBand(bands, "g", 10, 20, 12); // t0 === last.t1 → extend
    expect(bands).toEqual([{ layer: "g", t0: 0, t1: 20 }]);
    __pushBand(bands, "g", 5, 25, 12); // t0 < last.t1 (overlap) → extend
    expect(bands).toEqual([{ layer: "g", t0: 0, t1: 25 }]);
    __pushBand(bands, "g", 40, 50, 12); // gap → new band
    expect(bands).toEqual([
      { layer: "g", t0: 0, t1: 25 },
      { layer: "g", t0: 40, t1: 50 },
    ]);
  });

  test("over cap, drops the smallest-width band and never bridges a gap", () => {
    const bands: WaitBand[] = [];
    __pushBand(bands, "g", 0, 10, 2); // width 10
    __pushBand(bands, "g", 20, 23, 2); // width 3 — the smallest
    __pushBand(bands, "g", 40, 50, 2); // over cap → drop the width-3 band
    expect(bands).toEqual([
      { layer: "g", t0: 0, t1: 10 },
      { layer: "g", t0: 40, t1: 50 },
    ]);
  });
});

describe("positioned wait bands", () => {
  // Bands are observable only on FlightSpans (the ring / open capture), never on
  // the label-keyed aggregates — same as the per-instance ids.
  function completed(label: string): FlightSpan {
    const found = captureFlightWindow({ windowStartMs: 0 }).completed.find(
      (s) => s.label === label,
    );
    if (!found) throw new Error(`no completed span for ${label}`);
    return found;
  }

  test("per-layer band widths sum to the layer union; cross-layer union equals waitMs", async () => {
    await recordEntrySpan("loader", "l", async () => {
      fakeNow = 10;
      chargeWait("db-acquire", 10); // [0,10]
      fakeNow = 30;
      chargeWait("db-acquire", 10); // [20,30] — disjoint from the first
      fakeNow = 60;
      chargeWait("read-admit", 20); // [40,60]
    });
    const span = completed("l");
    const bands = span.waitBands!;
    // Each layer's band widths reconstruct exactly that layer's scalar union.
    for (const layer of ["db-acquire", "read-admit"]) {
      const sum = bands
        .filter((b) => b.layer === layer)
        .reduce((s, b) => s + (b.t1 - b.t0), 0);
      expect(sum).toBe(span.waits![layer]!);
    }
    // The cross-layer band union is the authoritative waitMs — the property the
    // whole design rests on: Σ band widths cannot drift from the scalar union.
    expect(crossLayerUnion(bands)).toBe(span.waitMs);
    expect(span.waitMs).toBe(40); // [0,10] ∪ [20,30] ∪ [40,60]
  });

  test("overlapping layers: both carry bands; cross-layer union < per-layer sum, == waitMs", async () => {
    await recordEntrySpan("loader", "l", async () => {
      fakeNow = 50;
      chargeWait("db-acquire", 40); // [10,50]
      fakeNow = 60;
      chargeWait("read-admit", 30); // [30,60] — overlaps the first in time
    });
    const span = completed("l");
    const bands = span.waitBands!;
    const perLayerSum = bands.reduce((s, b) => s + (b.t1 - b.t0), 0);
    expect(perLayerSum).toBe(70); // 40 + 30, counting the [30,50] overlap twice
    expect(span.waitMs).toBe(50); // [10,50] ∪ [30,60] = [10,60]
    expect(crossLayerUnion(bands)).toBe(span.waitMs);
    expect(crossLayerUnion(bands)).toBeLessThan(perLayerSum);
  });

  test("overflow drops the smallest band, never fills a gap; residual == dropped width", async () => {
    await recordEntrySpan("loader", "l", async () => {
      // WAIT_BAND_CAP + 1 disjoint waits on one layer. Wait #0 is width 1 (the
      // smallest, to be dropped); the rest are width 10, spaced so they never
      // merge. All end-ordered.
      let t = 0;
      for (let i = 0; i <= WAIT_BAND_CAP; i++) {
        const width = i === 0 ? 1 : 10;
        t = i * 100 + width;
        fakeNow = t;
        chargeWait("db-acquire", width);
      }
      fakeNow = t;
    });
    const span = completed("l");
    const bands = span.waitBands!;
    expect(bands).toHaveLength(WAIT_BAND_CAP);
    // The width-1 band was dropped whole, not merged across its 90ms gap.
    expect(bands.every((b) => b.t1 - b.t0 === 10)).toBe(true);
    // waitMs still counts the dropped 1ms; the bands simply no longer position
    // it — the residual is exactly the dropped width, no gap was invented.
    expect(span.waitMs - crossLayerUnion(bands)).toBe(1);
  });

  test("an open span's live bands appear at their true offsets mid-flight", async () => {
    await recordEntrySpan("loader", "l", async () => {
      fakeNow = 20;
      chargeWait("db-acquire", 10); // [10,20]
      fakeNow = 60;
      chargeWait("db-acquire", 20); // [40,60] — disjoint
      fakeNow = 70;
      const span = captureFlightWindow({ windowStartMs: 0 }).open[0]!;
      expect(span.waitBands).toEqual([
        { layer: "db-acquire", t0: 10, t1: 20 },
        { layer: "db-acquire", t0: 40, t1: 60 },
      ]);
      expect(crossLayerUnion(span.waitBands!)).toBe(span.waitMs);
    });
  });

  test("a zero-ms marker charge produces no band", async () => {
    await recordEntrySpan("loader", "l", async () => {
      fakeNow = 10;
      chargeWait("git-memo-hit", 0);
      fakeNow = 20;
    });
    const span = completed("l");
    // The layer key still records in `waits` (consulted, 0ms), but there is no
    // interval to position, so no band — and none created a stray empty list.
    expect(span.waits).toEqual({ "git-memo-hit": 0 });
    expect(span.waitBands).toBeUndefined();
  });

  test("resetRuntimeProfile clears the flight-ring wait bands", async () => {
    await recordEntrySpan("loader", "l", async () => {
      fakeNow = 30;
      chargeWait("db-acquire", 30);
    });
    expect(completed("l").waitBands).toEqual([
      { layer: "db-acquire", t0: 0, t1: 30 },
    ]);
    resetRuntimeProfile();
    expect(captureFlightWindow({ windowStartMs: 0 }).completed).toHaveLength(0);
  });
});

describe("monitoring self-meter", () => {
  // The meter is cumulative-since-boot module state (deliberately NOT cleared by
  // resetRuntimeProfile — the consumer diffs readings), so every assertion here
  // is on the DELTA across the exercised scopes.
  function meterDelta(before: { count: number; totalMs: number }): {
    count: number;
    totalMs: number;
  } {
    const after = getSelfMeter();
    return {
      count: after.count - before.count,
      totalMs: after.totalMs - before.totalMs,
    };
  }

  test("a sync scope adds one op and its wall time", () => {
    const before = getSelfMeter();
    const out = runWithoutProfiling(() => {
      fakeNow = 12;
      return "ok";
    });
    expect(out).toBe("ok");
    expect(meterDelta(before)).toEqual({ count: 1, totalMs: 12 });
  });

  test("a sync throw still settles the meter", () => {
    const before = getSelfMeter();
    expect(() =>
      runWithoutProfiling(() => {
        fakeNow += 7;
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(meterDelta(before)).toEqual({ count: 1, totalMs: 7 });
  });

  test("nested scopes meter only the OUTERMOST scope's wall time", () => {
    const before = getSelfMeter();
    runWithoutProfiling(() => {
      fakeNow += 10;
      // Nested: already suppressed, so this scope adds neither count nor time —
      // its 5ms is inside the outer wall, counted exactly once.
      runWithoutProfiling(() => {
        fakeNow += 5;
      });
      fakeNow += 10;
    });
    expect(meterDelta(before)).toEqual({ count: 1, totalMs: 25 });
  });

  test("an async scope is timed to settlement, nesting detected across awaits", async () => {
    const before = getSelfMeter();
    const gate = deferred();
    const p = runWithoutProfiling(async () => {
      await gate.promise;
      // Nested async scope AFTER an await: ALS propagation keeps suppression
      // active here, so it must not double-count.
      runWithoutProfiling(() => {
        fakeNow += 5;
      });
      fakeNow = 100;
      return 42;
    });
    fakeNow = 40; // time passes while the scope is pending
    gate.resolve();
    expect(await p).toBe(42);
    // settle is attached before the caller's await, so it has run by now.
    expect(meterDelta(before)).toEqual({ count: 1, totalMs: 100 });
  });

  test("a rejected async scope still settles the meter (and stays rejected)", async () => {
    const before = getSelfMeter();
    const gate = deferred();
    const p = runWithoutProfiling(async () => {
      await gate.promise;
      fakeNow = 30;
      throw new Error("async-boom");
    });
    gate.resolve();
    let message = "";
    try {
      await p;
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe("async-boom");
    // Let the detached settle continuation run (it was attached first, but be
    // explicit rather than rely on continuation ordering).
    await Promise.resolve();
    expect(meterDelta(before)).toEqual({ count: 1, totalMs: 30 });
  });

  test("concurrent OUTERMOST scopes each meter their full wall (a sum)", async () => {
    const before = getSelfMeter();
    const gate = deferred();
    const a = runWithoutProfiling(async () => {
      await gate.promise; // opened at t=0
    });
    fakeNow = 10;
    const b = runWithoutProfiling(async () => {
      await gate.promise; // opened at t=10, fully overlapping a
    });
    fakeNow = 50;
    gate.resolve();
    await Promise.all([a, b]);
    // Two separate monitoring work items: 50 + 40, not a wall union.
    expect(meterDelta(before)).toEqual({ count: 2, totalMs: 90 });
  });

  test("suppression semantics are unchanged: spans inside the scope are dropped", async () => {
    await runWithoutProfiling(async () => {
      recordSpan("db", "suppressed-query", 500);
      await recordEntrySpan("loader", "suppressed-loader", async () => {
        fakeNow += 3;
      });
    });
    const profile = getRuntimeProfile();
    expect(
      profile.aggregates.db.find((a) => a.label === "suppressed-query"),
    ).toBeUndefined();
    expect(
      profile.aggregates.loader.find((a) => a.label === "suppressed-loader"),
    ).toBeUndefined();
  });
});

describe("span detail", () => {
  test("variant + measures reach the slowest ring and onSlowSpan; measuresMax keeps each measure's max", async () => {
    const seen: SlowSpan[] = [];
    const sub = onSlowSpan((s) => seen.push(s), { thresholdMs: 0 });
    try {
      recordSpan("push", "deliver:tasks", 5, {
        measures: { subscribers: 3, frameChars: 900 },
      });
      recordSpan("push", "deliver:tasks", 7, {
        measures: { subscribers: 8, frameChars: 100 },
      });
      await recordEntrySpan(
        "loader",
        "task",
        () => {
          fakeNow = 4;
        },
        { variant: '{"id":"42"}', measures: { ids: 2 } },
      );
    } finally {
      sub.dispose();
    }

    expect(agg("push", "deliver:tasks").measuresMax).toEqual({
      subscribers: 8,
      frameChars: 900,
    });
    const loader = seen.find((s) => s.kind === "loader")!;
    expect(loader.detail).toEqual({
      variant: '{"id":"42"}',
      measures: { ids: 2 },
    });
    expect(getRuntimeProfile().slowest.loader[0]!.detail?.variant).toBe(
      '{"id":"42"}',
    );
  });

  test("an empty detail is recorded as no detail, and a long variant is capped", () => {
    recordSpan("route", "tasks", 1, { measures: {} });
    recordSpan("route", "tasks", 1, { variant: "x".repeat(1000) });
    const details = getRuntimeProfile().slowest.route.map((s) => s.detail);
    expect(details).toContainEqual(undefined);
    expect(details.find((d) => d)!.variant!.length).toBe(200);
    expect(agg("route", "tasks").measuresMax).toBeUndefined();
  });
});
