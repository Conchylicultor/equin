// Who a wait is filed for, through the real recorder: the handlers below are
// install-slow-span's decisions (which waits are a reader's, which bar), so a
// page's wait on a slow worker is still `wait <layer>`, while the same wait
// under background work comes back to that op as its own time.
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

/** `kind label` waits `ms` on the worker, inside its own entry. */
async function waitOnWorker(
  kind: SpanKind,
  label: string,
  ms: number,
  budgetMs?: number,
): Promise<void> {
  await recordEntrySpan(
    kind,
    label,
    async () => {
      const end = beginWait("worker:test-index", "io");
      fakeNow += ms;
      end();
    },
    undefined,
    undefined,
    budgetMs === undefined ? undefined : { budgetMs },
  );
}

describe("a wait is filed as the gate's only for a reader", () => {
  test("a page's read waiting on the worker files the wait", async () => {
    await waitOnWorker("loader", "plugin-view.tree", 2500);
    expect(filed).toEqual([
      "wait worker:test-index 2500 by loader plugin-view.tree",
    ]);
  });

  test("background work's wait is its own time, judged on its own bar", async () => {
    await waitOnWorker("bg", "first-build", 2500);
    expect(filed).toEqual(["bg first-build own 2500"]);
  });

  test("a warm-up within its budget files nothing", async () => {
    await waitOnWorker("bg", "warmup:trees", 1500, 4000);
    expect(filed).toEqual([]);
  });

  test("a warm-up within a budget above the wait bar files nothing", async () => {
    await waitOnWorker("bg", "warmup:trees", 2500, 4000);
    expect(filed).toEqual([]);
  });

  test("a gate held across a warm-up and a page is the page's wait too", async () => {
    // Each waited 1.5 s, under every bar; back to back the gate held 3 s.
    await waitOnWorker("bg", "warmup:trees", 1500, 4000);
    await waitOnWorker("loader", "plugin-view.tree", 1500);
    expect(filed).toEqual(["wait worker:test-index 3000 by bg warmup:trees"]);
  });

  test("a warm-up past its budget files itself, not the wait", async () => {
    await waitOnWorker("bg", "warmup:trees", 2500, 2000);
    expect(filed).toEqual(["bg warmup:trees own 2500"]);
  });
});
