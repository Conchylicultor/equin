// Who a wait is filed for, through the real recorder: the handlers below are
// install-slow-span's decisions (which waits are a reader's, which bar). A
// queue is a reader's latency only: under background work it is no one's,
// neither filed against the gate nor that op's own time. An `io` wait — a
// worker's answer, a git child — is another party's work, judged on its own
// whoever waited; under the bar it is the waiter's work.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncLocalStorage } from "node:async_hooks";
import {
  beginWait,
  installSpanContextRuntime,
  onSlowSpan,
  onSlowWait,
  recordEntrySpan,
  resetRuntimeProfile,
  type EntryContext,
  type SpanKind,
} from "@plugins/infra/plugins/runtime-profiler/core";
import { installClock } from "@plugins/infra/plugins/runtime-profiler/core/testing";
import {
  isReaderWait,
  resolveSlowThreshold,
  resolveWaitThreshold,
  slowSpanMs,
  type Thresholds,
} from "./resolve-threshold";

const thresholds: Thresholds = {
  pageLoadMs: 2000,
  elementMs: 1000,
  updateMs: 1000,
  confirmMs: 2000,
  loaderMs: 2000,
  httpMs: 2000,
  dbMs: 500,
  jobMs: 3000,
  browserHostBootMs: 5000,
};

const als = new AsyncLocalStorage<EntryContext>();
installSpanContextRuntime({
  run: (ctx, fn) => als.run(ctx, fn),
  current: () => als.getStore(),
});

let fakeNow = 0;
let filed: string[] = [];
let subs: { dispose: () => void }[] = [];

beforeEach(() => {
  fakeNow = 0;
  installClock(() => fakeNow);
  resetRuntimeProfile();
  filed = [];
  subs = [
    onSlowWait(
      (wait) => {
        if (!isReaderWait(wait)) return false;
        if (wait.ms < resolveWaitThreshold(wait, thresholds)) return false;
        filed.push(
          `wait ${wait.layer} ${wait.ms} by ${wait.caller.kind} ${wait.caller.label}`,
        );
        return true;
      },
      { thresholdMs: 1 },
    ),
    onSlowSpan(
      (span, claim) => {
        const ownMs = slowSpanMs(span);
        if (ownMs < resolveSlowThreshold(span, thresholds)) return;
        filed.push(`${span.kind} ${span.label} own ${ownMs}`);
        claim();
      },
      { thresholdMs: 1 },
    ),
  ];
});

afterEach(() => {
  for (const s of subs) s.dispose();
});

/** `kind label` waits `ms` on `layer` (of `waitKind`), inside its own entry. */
async function waitIn(
  kind: SpanKind,
  label: string,
  waitKind: "queue" | "io",
  layer: string,
  ms: number,
  budgetMs?: number,
): Promise<void> {
  await recordEntrySpan(
    kind,
    label,
    async () => {
      const end = beginWait(layer, waitKind);
      fakeNow += ms;
      end();
    },
    undefined,
    undefined,
    budgetMs === undefined ? undefined : { budgetMs },
  );
}

const onGate = (kind: SpanKind, label: string, ms: number, budgetMs?: number) =>
  waitIn(kind, label, "queue", "test-gate-acquire", ms, budgetMs);

const onWorker = (
  kind: SpanKind,
  label: string,
  ms: number,
  budgetMs?: number,
) => waitIn(kind, label, "io", "worker:test-index", ms, budgetMs);

describe("a queue is filed as the gate's only for a reader", () => {
  test("a page's read queued on the gate files the wait", async () => {
    await onGate("loader", "plugin-view.tree", 2500);
    expect(filed).toEqual([
      "wait test-gate-acquire 2500 by loader plugin-view.tree",
    ]);
  });

  test("background work's queue is neither the gate's report nor its own time", async () => {
    await onGate("bg", "first-build", 2500);
    expect(filed).toEqual([]);
  });

  test("a warm-up queued past its budget only by waiting files nothing", async () => {
    await onGate("bg", "warmup:trees", 2500, 2000);
    expect(filed).toEqual([]);
  });

  test("a gate held across a warm-up and a page is the page's wait too", async () => {
    // Each queued 1.5 s, under every bar; back to back the gate held 3 s.
    await onGate("bg", "warmup:trees", 1500, 4000);
    await onGate("loader", "plugin-view.tree", 1500);
    expect(filed).toEqual(["wait test-gate-acquire 3000 by bg warmup:trees"]);
  });
});

describe("an io wait is judged on its own, whoever waited", () => {
  test("a page's read waiting on a slow worker files the worker", async () => {
    await onWorker("loader", "plugin-view.tree", 2500);
    expect(filed).toEqual([
      "wait worker:test-index 2500 by loader plugin-view.tree",
    ]);
  });

  test("background work waiting on a slow worker files the worker, not itself", async () => {
    // 2026-11-19 → this change: filed by no one (`plugin-tree:first-build`).
    await onWorker("bg", "first-build", 2500);
    expect(filed).toEqual(["wait worker:test-index 2500 by bg first-build"]);
  });

  test("work a warm-up awaited is held to the warm-up's declared budget", async () => {
    // The worker's 2.5 s is part of the 4 s the warm-up said it takes.
    await onWorker("bg", "warmup:trees", 2500, 4000);
    expect(filed).toEqual([]);
    await onWorker("bg", "warmup:trees", 4500, 4000);
    expect(filed).toEqual(["wait worker:test-index 4500 by bg warmup:trees"]);
  });

  test("a job's child is held to the job's bar, never below the wait bar", async () => {
    // An unregistered job name falls back to `jobMs` (3 s).
    await onWorker("job", "backup.run", 2500);
    expect(filed).toEqual([]);
    await onWorker("job", "backup.run", 3500);
    expect(filed).toEqual(["wait worker:test-index 3500 by job backup.run"]);
  });

  test("a worker under its bar is the waiter's work, judged as the waiter", async () => {
    await onWorker("bg", "first-build", 1500);
    await onWorker("bg", "warmup:trees", 1500, 4000);
    expect(filed).toEqual([]);
    await recordEntrySpan("bg", "pass", async () => {
      fakeNow += 600; // its own code
      const end = beginWait("worker:test-index", "io");
      fakeNow += 1500;
      end();
    });
    expect(filed).toEqual(["bg pass own 2100"]);
  });

  test("io waits under the bar on different layers are judged as their sum", async () => {
    // bg watch-edited-files:pass on main: git status + git diff, each under
    // the bar, filed by no one 67 times in 7 days (2026-11-12 → 11-19).
    await recordEntrySpan("bg", "watch-edited-files:pass", async () => {
      let end = beginWait("git:status", "io");
      fakeNow += 1500;
      end();
      end = beginWait("git:diff", "io");
      fakeNow += 660;
      end();
    });
    expect(filed).toEqual(["bg watch-edited-files:pass own 2160"]);
  });

  test("an io wait filed on its own is not its waiter's time too", async () => {
    await recordEntrySpan("bg", "pass", async () => {
      fakeNow += 600;
      const end = beginWait("git:status", "io");
      fakeNow += 2500;
      end();
    });
    expect(filed).toEqual(["wait git:status 2500 by bg pass"]);
  });

  test("io waits never form a gate's busy stretch", async () => {
    // Two loaders each awaiting a 1.5 s git child back to back: two pieces of
    // work under the bar, not a queue that held 3 s.
    await onWorker("loader", "a", 1500);
    await onWorker("loader", "b", 1500);
    expect(filed).toEqual([]);
  });
});
