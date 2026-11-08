import { expect, test } from "bun:test";
// The server barrel installs the profiler's AsyncLocalStorage context at module
// eval, as at boot — without it every entry is a passthrough with nothing open.
import "@plugins/infra/plugins/runtime-profiler/server";
import {
  captureFlightWindow,
  recordEntrySpan,
  type FlightSpan,
} from "@plugins/infra/plugins/runtime-profiler/core";
import type { AcquireHooks } from "@plugins/packages/plugins/host-semaphore/server";
import { meterAcquire } from "./meter-acquire";

// No real pool: a fake acquire drives the hooks the way host-semaphore does
// (slow path → `onWaitStart`, then `onAcquired(waitMs)`; a cancelled one
// throws without `onAcquired`), so the test reads only what the metering adds.

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
}

function openSpan(label: string): FlightSpan {
  const span = captureFlightWindow({ windowStartMs: 0 }).open.find(
    (s) => s.label === label,
  );
  if (!span) throw new Error(`no open span ${label}`);
  return span;
}

test("a slow-path acquire shows its wait on the pool's layer, then charges it, and the caller's hooks still fire", async () => {
  const granted = deferred();
  const seen: string[] = [];
  let queued!: FlightSpan;
  let admitted!: FlightSpan;
  await recordEntrySpan("job", "meter-acquire-slow", async () => {
    const run = meterAcquire(
      "db-fork-acquire",
      {
        onWaitStart: () => seen.push("start"),
        onAcquired: () => seen.push("acquired"),
      },
      async (hooks: AcquireHooks) => {
        hooks.onWaitStart?.();
        await granted.promise;
        hooks.onAcquired?.(5);
        admitted = openSpan("meter-acquire-slow");
        return "ok";
      },
    );
    queued = openSpan("meter-acquire-slow");
    granted.resolve();
    expect(await run).toBe("ok");
  });
  expect(queued.waiting?.map((w) => w.layer)).toEqual(["db-fork-acquire"]);
  expect(admitted.waiting).toBeUndefined();
  // Charged: the layer is in the span's waits (its length is the clock's —
  // another suite in this process may have installed a fake one).
  expect(Object.keys(admitted.waits ?? {})).toEqual(["db-fork-acquire"]);
  expect(seen).toEqual(["start", "acquired"]);
});

test("a cancelled acquire stops showing its wait", async () => {
  let after!: FlightSpan;
  await recordEntrySpan("job", "meter-acquire-cancelled", async () => {
    const run = meterAcquire("db-fork-acquire", undefined, async (hooks) => {
      hooks.onWaitStart?.();
      await Promise.resolve();
      throw new Error("aborted");
    });
    await run.catch((err: unknown) => {
      if (!(err instanceof Error) || err.message !== "aborted") throw err;
    });
    after = openSpan("meter-acquire-cancelled");
  });
  expect(after.waiting).toBeUndefined();
});
