/**
 * The central `serveValue`'s `recomputeOn` takes only an EXTERNAL upstream
 * (T15) — the same `ExternalServed` the worktree `serveValue` and
 * `compileValue` take (`../../shared/compile-value.ts`), so the three cannot
 * drift. Type-level: the assertions are the `@ts-expect-error`s; the runtime
 * refusal of a cast is pinned in `shared/compile-value.test.ts`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { liveValue } from "@plugins/network/plugins/live/core";
import type { ServedValueBase } from "../../shared/compile-value";
import { serveValue, type CentralServedValue } from "./serve-value";

const Count = z.object({ n: z.number() });

describe("central serveValue — recomputeOn (T15)", () => {
  test("types: an external upstream is taken, a db one is refused", () => {
    const key = `test.central-serve-value.${Date.now()}`;
    const central = liveValue(key, { schema: Count, origin: "central" });
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      const external = null as unknown as CentralServedValue<
        { n: number },
        Record<string, string>
      >;
      const db = null as unknown as ServedValueBase<
        { n: number },
        Record<string, string>
      >;
      serveValue(central, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 0 }),
        recomputeOn: [external],
      });
      // An overloaded call reports it at the call.
      // @ts-expect-error — a db value has no `notify`: not an upstream
      serveValue(central, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 0 }),
        recomputeOn: [db],
      });
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("central serveValue — changes", () => {
  test("required; only a notified value has notify", () => {
    const key = (n: string) =>
      `test.central-serve-value.changes.${n}.${Date.now()}`;
    const fixedValue = liveValue(key("f"), {
      schema: Count,
      origin: "central",
    });
    const fixed = serveValue(fixedValue, {
      source: "external",
      changes: { fixed: { reason: "constant for the process" } },
      loader: () => ({ n: 0 }),
    });
    expect(fixed.changes).toEqual({
      fixed: { reason: "constant for the process" },
    });
    // Runtime too: a silent arm is handed no `notify`.
    expect("notify" in fixed).toBe(false);
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      // @ts-expect-error — `changes` is required on the external arm
      serveValue(fixedValue, { source: "external", loader: () => ({ n: 0 }) });
      // @ts-expect-error — a fixed value is never told of a change
      fixed.notify();
    };
    expect(typeof typeOnly).toBe("function");
  });
});
