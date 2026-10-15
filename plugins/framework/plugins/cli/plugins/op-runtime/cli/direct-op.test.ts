import { describe, expect, test } from "bun:test";
import type {
  Grant,
  Lane,
} from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { asNamespace } from "@plugins/infra/plugins/namespace/core";
import type {
  OpEvent,
  OpSummary,
} from "@plugins/debug/plugins/profiling/plugins/op-log/core";
import { createOpProfiler } from "@plugins/debug/plugins/profiling/plugins/op-log/server";
import type { FlightLeader } from "@plugins/packages/plugins/single-flight/core";
import { withDirectOp, type DirectOpDeps } from "./direct-op";

// Pure-logic tests of the direct-op lifecycle: every seam injected (no real
// flock, no marker file, no op-log append, no signal handler), so what is
// asserted is the ORDER and the GATING — the two things the three hand-rolled
// copies this replaced could disagree about.

function fakeGrant(units: number, lane: Lane): Grant {
  return {
    units,
    lane,
    run: (fn) => fn(),
    env: () => ({
      SINGULARITY_HOST_GRANT: String(units),
      SINGULARITY_HOST_LANE: lane,
    }),
  };
}

/**
 * Await `p` and return the Error it rejected with; throw if it resolved.
 * `expect(p).rejects.toThrow()` is typed `void` under bun:test (the same helper
 * the spawn and host-semaphore suites carry), so this asserts the rejection for
 * real and hands back the error.
 */
async function rejection(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected the promise to reject, but it resolved");
}

/** The terminal summary, or undefined when no `completed` event landed. */
function terminalOf(records: OpEvent[]): OpSummary | undefined {
  const last = records.find((r) => r.e === "completed");
  return last?.e === "completed" ? last.summary : undefined;
}

/**
 * How the injected single-flight behaves. `lead`: the key is free, so the
 * caller leads (and what it publishes is captured). `join`: an identical run
 * is in flight and publishes `outcome`. `join-then-lead`: the caller waits on
 * a leader whose verdict it cannot adopt, then leads. `busy`: (nested) the key
 * is held, so `tryLead` refuses.
 */
type FlightScript =
  | { kind: "lead" }
  | { kind: "join"; outcome: "success" | "failed" }
  | { kind: "join-then-lead" }
  | { kind: "busy" };

const LEADER: FlightLeader = { id: "leader-op", pid: 4242, startedAt: 0 };

function makeHarness(
  opts: { inherited?: Grant; slug?: string; flight?: FlightScript } = {},
) {
  const events: string[] = [];
  const records: OpEvent[] = [];
  const exitHandlers: (() => void)[] = [];
  const published: unknown[] = [];
  const flightKeys: string[] = [];
  const script = opts.flight ?? { kind: "lead" };
  const slug = asNamespace(opts.slug ?? "wt-a");
  const deps: DirectOpDeps = {
    inheritedGrant: () => opts.inherited,
    withHostGrant: async (o, fn) => {
      events.push(`acquire:${o.lane}:${o.max}`);
      o.hooks?.onWaitStart?.();
      o.hooks?.onAcquired?.(0);
      try {
        return await fn(fakeGrant(2, o.lane));
      } finally {
        events.push("release");
      }
    },
    identity: async () => ({ slug, branch: "feature" }),
    checkBroadcasts: async (kind) => {
      events.push(`broadcasts:${kind}`);
    },
    reportInterruptedPredecessor: (s) => {
      events.push(`predecessor:${s}`);
    },
    publishLane: (interactive) => {
      events.push(`lane:${interactive ? "interactive" : "background"}`);
    },
    // The requested / completed events land in `events` too, so the ORDER
    // against the marker (publish before `requested`, release after
    // `completed`) is asserted, not assumed.
    createOpProfiler: (kind, o) =>
      createOpProfiler(kind, {
        ...o,
        sink: (r) => {
          records.push(r);
          if (r.e === "requested" || r.e === "completed")
            events.push(`log:${r.e}`);
        },
      }),
    markWorktreeOpStart: (_slug, op, _opId) => {
      events.push(`marker:${op}:publish`);
      let released = false;
      return {
        path: "/dev/null",
        release: () => {
          if (released) return;
          released = true;
          events.push(`marker:${op}:release`);
        },
      };
    },
    onExit: (fn) => exitHandlers.push(fn),
    installFatalSignalExit: async (opId) => {
      events.push(`signals:${opId.length > 0 ? "armed" : "?"}`);
    },
    // `_slug` above: the stubs record the op, not the slug — every call in a
    // run carries the same one, asserted once through `predecessor:<slug>`.
    singleFlight: (async (o, lead) => {
      flightKeys.push(o.key);
      events.push("flight");
      const publish = (v: unknown) => published.push(v);
      if (script.kind === "join") {
        o.onJoin?.(LEADER);
        // Only what the schema accepts is ever adopted.
        const verdict = o.schema.parse({ outcome: script.outcome });
        if (!o.adoptable(verdict)) throw new Error("expected adoptable");
        return { role: "joined", leader: LEADER, verdict };
      }
      if (script.kind === "join-then-lead") o.onJoin?.(null);
      return { role: "led", result: await lead(publish) };
    }) as DirectOpDeps["singleFlight"],
    tryLead: (async (o, lead) => {
      flightKeys.push(o.key);
      events.push("try-lead");
      if (script.kind === "busy") return { role: "busy" };
      return {
        role: "led",
        result: await lead((v: unknown) => published.push(v)),
      };
    }) as DirectOpDeps["tryLead"],
    log: (line) => events.push(`log-line:${line.slice(0, 20)}`),
  };
  return { deps, events, records, exitHandlers, published, flightKeys };
}

describe("withDirectOp — top-level path", () => {
  test("runs the whole lifecycle in order and stamps the body's outcome", async () => {
    const h = makeHarness();
    const seen: string[] = [];
    const outcome = await withDirectOp(
      "test",
      { max: 4 },
      async (grant, ctx) => {
        seen.push(`body:${grant.units}:${ctx.nested}:${ctx.lane}`);
        expect(ctx.profiler).toBeDefined();
        return "success";
      },
      h.deps,
    );
    expect(outcome).toBe("success");
    expect(seen).toEqual(["body:2:false:background"]);
    // The marker is published BEFORE `requested` and released only AFTER
    // `completed` is in the log: a reader never sees a logged op without a
    // locked marker unless its process died.
    expect(h.events).toEqual([
      "broadcasts:test",
      "predecessor:wt-a",
      "lane:background",
      "marker:test:publish",
      "log:requested",
      "signals:armed",
      "acquire:background:4",
      "release",
      "log:completed",
      "marker:test:release",
    ]);
    expect(h.records.map((r) => r.e)).toContain("granted");
    const completed = terminalOf(h.records);
    expect(completed?.kind).toBe("test");
    expect(completed?.outcome).toBe("success");
    expect(completed?.waits.map((w) => w.kind)).toEqual(["host-grant"]);
    // The exit handler (the `process.exit` inside a body path, which skips the
    // finally) is idempotent: no second terminal, no second release.
    for (const fn of h.exitHandlers) fn();
    expect(h.events.filter((e) => e.startsWith("log:completed"))).toHaveLength(
      1,
    );
    expect(h.events.filter((e) => e === "marker:test:release")).toHaveLength(1);
  });

  test("the main worktree is the interactive origin", async () => {
    const h = makeHarness({ slug: "singularity" });
    await withDirectOp("e2e", { max: 1 }, async () => "success", h.deps);
    expect(h.events).toContain("lane:interactive");
    expect(h.events).toContain("acquire:interactive:1");
  });

  test("a failed body is stamped failed; a throwing body still writes its terminal, then releases", async () => {
    const h = makeHarness();
    const outcome = await withDirectOp(
      "check",
      { max: 1 },
      async () => "failed",
      h.deps,
    );
    expect(outcome).toBe("failed");
    for (const fn of h.exitHandlers) fn();
    expect(terminalOf(h.records)?.outcome).toBe("failed");

    const h2 = makeHarness();
    const err = await rejection(
      withDirectOp(
        "check",
        { max: 1 },
        async () => {
          throw new Error("boom");
        },
        h2.deps,
      ),
    );
    expect(err.message).toBe("boom");
    expect(h2.events.slice(-2)).toEqual([
      "log:completed",
      "marker:check:release",
    ]);
    // No outcome was stamped, so the terminal record lands as "error".
    expect(terminalOf(h2.records)?.outcome).toBe("error");
  });

  test("a top-level op mints its own id; an adopted id is honoured", async () => {
    const h = makeHarness();
    let minted = "";
    await withDirectOp(
      "test",
      { max: 1 },
      async (_g, ctx) => {
        minted = ctx.opId;
        return "success";
      },
      h.deps,
    );
    expect(minted.length).toBeGreaterThan(0);
    expect(h.records[0]?.opId).toBe(minted);

    const h2 = makeHarness();
    await withDirectOp(
      "check",
      { max: 1, opId: "parent-op" },
      async (_g, ctx) => {
        expect(ctx.opId).toBe("parent-op");
        return "success";
      },
      h2.deps,
    );
  });
});

describe("withDirectOp — nested path (a parent's grant in the environment)", () => {
  test("spends the inherited grant and writes nothing of its own", async () => {
    const inherited = fakeGrant(3, "interactive");
    const h = makeHarness({ inherited });
    const outcome = await withDirectOp(
      "check",
      { max: 99 },
      async (grant, ctx) => {
        expect(grant).toBe(inherited);
        expect(ctx.nested).toBe(true);
        expect(ctx.profiler).toBeUndefined();
        return "success";
      },
      h.deps,
    );
    expect(outcome).toBe("success");
    // Only the lane is published (not-clobbered by the real publishLane); no
    // banner, no predecessor, no marker, no signal handlers, no acquire.
    expect(h.events).toEqual(["lane:background"]);
    expect(h.records).toEqual([]);
    expect(h.exitHandlers).toEqual([]);
  });
});

describe("withDirectOp — run-level single-flight (opts.flight)", () => {
  const adoptInto = (seen: string[]) => ({
    key: "same-work",
    adopt: (
      j: { outcome: "success" | "failed"; leader: FlightLeader },
      ctx: { opId: string },
    ) => {
      seen.push(`adopt:${j.outcome}:${j.leader.id}:${ctx.opId.length > 0}`);
      return j.outcome;
    },
  });

  test("a joiner never takes a grant: it waits `in-flight` and completes with the leader's outcome", async () => {
    const h = makeHarness({ flight: { kind: "join", outcome: "failed" } });
    const seen: string[] = [];
    const outcome = await withDirectOp(
      "check",
      { max: 4, flight: adoptInto(seen) },
      async () => {
        throw new Error("a joiner must not run the body");
      },
      h.deps,
    );
    expect(outcome).toBe("failed");
    expect(seen).toEqual(["adopt:failed:leader-op:true"]);
    // Still an op (marker + requested + terminal), but no acquire at all.
    expect(h.events.some((e) => e.startsWith("acquire:"))).toBe(false);
    expect(h.events).toContain("marker:check:publish");
    expect(h.events).toContain("log:requested");
    expect(h.events.slice(-2)).toEqual([
      "log:completed",
      "marker:check:release",
    ]);
    // The kind is prepended to the caller's key.
    expect(h.flightKeys).toEqual(["check\nsame-work"]);

    const completed = terminalOf(h.records);
    expect(completed?.outcome).toBe("failed");
    expect(completed?.waits).toHaveLength(1);
    expect(completed?.waits[0]).toMatchObject({
      kind: "in-flight",
      reason: "check leader-op",
      result: "acquired",
    });
    // A joiner was never granted anything.
    expect(h.records.map((r) => r.e)).not.toContain("granted");
  });

  test("a leader runs under its grant and publishes its outcome as the shared verdict", async () => {
    const h = makeHarness({ flight: { kind: "lead" } });
    const seen: string[] = [];
    const outcome = await withDirectOp(
      "test",
      { max: 2, flight: adoptInto(seen) },
      async () => "success",
      h.deps,
    );
    expect(outcome).toBe("success");
    expect(seen).toEqual([]);
    expect(h.published).toEqual([{ outcome: "success" }]);
    // The flight is entered BEFORE the grant is asked for.
    expect(h.events.indexOf("flight")).toBeLessThan(
      h.events.indexOf("acquire:background:2"),
    );
  });

  test("an `error` outcome is not a verdict: nothing is published", async () => {
    const h = makeHarness({ flight: { kind: "lead" } });
    await withDirectOp(
      "check",
      { max: 1, flight: adoptInto([]) },
      async () => "error",
      h.deps,
    );
    expect(h.published).toEqual([]);
  });

  test("a join that cannot adopt closes its `in-flight` wait and leads", async () => {
    const h = makeHarness({ flight: { kind: "join-then-lead" } });
    const outcome = await withDirectOp(
      "check",
      { max: 1, flight: adoptInto([]) },
      async () => "success",
      h.deps,
    );
    expect(outcome).toBe("success");
    expect(h.events).toContain("acquire:background:1");
    const waits = terminalOf(h.records)?.waits ?? [];
    expect(waits.map((w) => [w.kind, w.result])).toEqual([
      ["in-flight", "aborted"],
      ["host-grant", "acquired"],
    ]);
    expect(waits[0]?.reason).toBe("check (starting)");
  });

  test("a nested op never waits: busy → it runs unshared on the inherited grant", async () => {
    const inherited = fakeGrant(3, "interactive");
    const h = makeHarness({ inherited, flight: { kind: "busy" } });
    let ran = false;
    const outcome = await withDirectOp(
      "check",
      { max: 9, flight: adoptInto([]) },
      async (grant) => {
        expect(grant).toBe(inherited);
        ran = true;
        return "success";
      },
      h.deps,
    );
    expect(outcome).toBe("success");
    expect(ran).toBe(true);
    expect(h.events).toContain("try-lead");
    expect(h.events).not.toContain("flight");
    expect(h.published).toEqual([]);
  });

  test("a nested op leads when the key is free, so a top-level duplicate can join it", async () => {
    const h = makeHarness({
      inherited: fakeGrant(1, "background"),
      flight: { kind: "lead" },
    });
    await withDirectOp(
      "check",
      { max: 1, flight: adoptInto([]) },
      async () => "failed",
      h.deps,
    );
    expect(h.events).toContain("try-lead");
    expect(h.published).toEqual([{ outcome: "failed" }]);
  });
});
