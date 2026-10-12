/**
 * `changes` — an external value's declared freshness: required, typed so only
 * `"notified"` carries `notify` / `whileSubscribed` / `recomputeOn` /
 * `throttleMs`, and paired with the declaration's `load: "snapshot"`. The type
 * half is asserted with `@ts-expect-error` (never-called closures), the
 * runtime half (an untyped caller) with throws; a snapshot's HTTP read is
 * driven through a real `createResourceRuntime`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createResourceRuntime } from "@plugins/framework/plugins/resource-runtime/core";
import { liveValue } from "@plugins/network/plugins/live/core";
import {
  compilePagedValue,
  compileQueryValue,
  compileValue,
  registerValue,
} from "../../shared/compile-value";
import { serveValue } from "./serve-value";

const Count = z.object({ n: z.number() });
const Query = z.object({ metric: z.string() });
const Item = z.object({ id: z.string() });

let seq = 0;
const key = (name: string) => `test.serve-value-changes.${name}.${seq++}`;

/** `serveValue` with its overloads erased — an untyped caller. */
const untyped = serveValue as (v: unknown, o: unknown) => unknown;

const FIXED = { fixed: { reason: "constant for the process" } } as const;
const SNAPSHOT = { snapshot: { reason: "measured on demand" } } as const;

describe("changes — types", () => {
  test("an external value must declare it; a db value may not", () => {
    const v = liveValue(key("required"), { schema: Count });
    const q = liveValue(key("required-q"), { schema: Count, query: Query });
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      // @ts-expect-error — `changes` is required on the external arm
      serveValue(v, { source: "external", loader: () => ({ n: 1 }) });
      // @ts-expect-error — …on a typed-query value too
      serveValue(q, { source: "external", loader: () => ({ n: 1 }) });
      // @ts-expect-error — …and through the compile helper
      compileValue(v, { source: "external", loader: () => ({ n: 1 }) });
      const dbWithChanges = {
        source: "db",
        loader: () => ({ n: 1 }),
        changes: "notified",
      } as const;
      // @ts-expect-error — a db value's freshness is the change feed's
      serveValue(v, dbWithChanges);
    };
    expect(typeof typeOnly).toBe("function");
  });

  test("only a notified value has notify", () => {
    const notified = serveValue(liveValue(key("n"), { schema: Count }), {
      source: "external",
      changes: "notified",
      loader: () => ({ n: 1 }),
    });
    const fixed = serveValue(liveValue(key("f"), { schema: Count }), {
      source: "external",
      changes: FIXED,
      loader: () => ({ n: 1 }),
    });
    const immutable = serveValue(
      liveValue(key("i"), { schema: Count, params: ["sha"] }),
      {
        source: "external",
        changes: { immutable: { reason: "sha-keyed" } },
        loader: () => ({ n: 1 }),
      },
    );
    const snapshot = serveValue(
      liveValue(key("s"), { schema: Count, load: "snapshot" }),
      { source: "external", changes: SNAPSHOT, loader: () => ({ n: 1 }) },
    );
    expect(typeof notified.notify).toBe("function");
    // Runtime too: the silent arms are handed no `notify` at all.
    for (const served of [fixed, immutable, snapshot]) {
      expect("notify" in served).toBe(false);
    }
    const typeOnly = () => {
      // @ts-expect-error — a fixed value is never told of a change
      fixed.notify();
      // @ts-expect-error — nor an immutable one
      immutable.notify({ sha: "a" });
      // @ts-expect-error — nor a snapshot
      snapshot.notify();
    };
    expect(typeof typeOnly).toBe("function");
  });

  test('change hooks only beside "notified"', () => {
    const v = liveValue(key("hooks"), { schema: Count });
    const up = serveValue(liveValue(key("up"), { schema: Count }), {
      source: "external",
      changes: "notified",
      loader: () => ({ n: 1 }),
    });
    const typeOnly = () => {
      serveValue(v, {
        source: "external",
        changes: FIXED,
        loader: () => ({ n: 1 }),
        // @ts-expect-error — a fixed value has no change signal to watch for
        whileSubscribed: () => () => {},
      });
      serveValue(v, {
        source: "external",
        changes: { immutable: { reason: "r" } },
        loader: () => ({ n: 1 }),
        // @ts-expect-error — nor an upstream to follow
        recomputeOn: [up],
      });
      serveValue(v, {
        source: "external",
        changes: FIXED,
        loader: () => ({ n: 1 }),
        // @ts-expect-error — nor a burst to throttle
        throttleMs: 100,
      });
      // The notified arm takes all three.
      serveValue(v, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
        throttleMs: 100,
        recomputeOn: [up],
        whileSubscribed: (_p, notify) => {
          notify();
          return () => {};
        },
      });
    };
    expect(typeof typeOnly).toBe("function");
  });

  test('snapshot pairs with load: "snapshot", takes no revalidate, and is never preloaded or paged', () => {
    const snap = liveValue(key("snap"), { schema: Count, load: "snapshot" });
    const plain = liveValue(key("plain"), { schema: Count });
    const snapQ = liveValue(key("snap-q"), {
      schema: Count,
      query: Query,
      load: "snapshot",
    });
    const paged = liveValue(key("paged"), {
      query: Query,
      paged: { item: Item, id: "id", limit: 10 },
    });
    expect(snap).toMatchObject({ load: "on-demand", snapshot: true });
    const typeOnly = () => {
      // @ts-expect-error — `{ snapshot }` needs a value declared `load: "snapshot"`
      serveValue(plain, {
        source: "external",
        changes: SNAPSHOT,
        loader: () => ({ n: 1 }),
      });
      // @ts-expect-error — and a snapshot value declares `{ snapshot }`
      serveValue(snap, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
      });
      // @ts-expect-error — …never `fixed`
      serveValue(snap, {
        source: "external",
        changes: FIXED,
        loader: () => ({ n: 1 }),
      });
      // @ts-expect-error — …nor the db arm
      serveValue(snap, { source: "db", loader: () => ({ n: 1 }) });
      serveValue(snap, {
        source: "external",
        changes: SNAPSHOT,
        loader: () => ({ n: 1 }),
        // @ts-expect-error — a snapshot's every read re-measures
        revalidate: () => Promise.resolve("etag"),
      });
      // A typed-query snapshot, through the compile helper.
      compileQueryValue(snapQ, {
        source: "external",
        changes: SNAPSHOT,
        loader: () => ({ n: 1 }),
      });
      compilePagedValue(paged, {
        source: "external",
        // @ts-expect-error — a paged value is never a snapshot
        changes: SNAPSHOT,
        loader: () => ({ items: [], nextCursor: null, meta: undefined }),
      });
      // @ts-expect-error — a snapshot is never preloaded
      liveValue(key("x"), { schema: Count, load: "snapshot", preload: "boot" });
      const preloadedParams = {
        schema: Count,
        params: ["a"],
        preload: "boot",
        load: "snapshot",
      } as const;
      // @ts-expect-error — nor a param'd preloaded one
      liveValue(key("y"), preloadedParams);
    };
    expect(typeof typeOnly).toBe("function");
  });
});

describe("changes — runtime (an untyped caller)", () => {
  test("refuses a missing or misplaced changes", () => {
    const v = liveValue(key("rt-missing"), { schema: Count });
    expect(() =>
      untyped(v, { source: "external", loader: () => ({ n: 1 }) }),
    ).toThrow(/must declare `changes`/);
    expect(() =>
      untyped(v, {
        source: "db",
        changes: "notified",
        loader: () => ({ n: 1 }),
      }),
    ).toThrow(/external arm's/);
    expect(() =>
      untyped(v, {
        source: "external",
        changes: { stale: { reason: "r" } },
        loader: () => ({ n: 1 }),
      }),
    ).toThrow(/is not "notified"/);
    expect(() =>
      untyped(v, {
        source: "external",
        changes: { fixed: { reason: "  " } },
        loader: () => ({ n: 1 }),
      }),
    ).toThrow(/reason` is empty/);
  });

  test("refuses change hooks beside a silent arm", () => {
    const v = liveValue(key("rt-hooks"), { schema: Count });
    expect(() =>
      untyped(v, {
        source: "external",
        changes: FIXED,
        loader: () => ({ n: 1 }),
        whileSubscribed: () => () => {},
        throttleMs: 5,
      }),
    ).toThrow(/`whileSubscribed`, `throttleMs` reacts to a change signal/);
  });

  test("refuses an unpaired snapshot, and a snapshot with revalidate", () => {
    const snap = liveValue(key("rt-snap"), {
      schema: Count,
      load: "snapshot",
    });
    const plain = liveValue(key("rt-plain"), { schema: Count });
    expect(() =>
      untyped(plain, {
        source: "external",
        changes: SNAPSHOT,
        loader: () => ({ n: 1 }),
      }),
    ).toThrow(/needs the value declared `load: "snapshot"`/);
    expect(() =>
      untyped(snap, {
        source: "external",
        changes: "notified",
        loader: () => ({ n: 1 }),
      }),
    ).toThrow(/declares `changes: \{ snapshot/);
    expect(() =>
      untyped(snap, { source: "db", loader: () => ({ n: 1 }) }),
    ).toThrow(/is served `source: "external"`/);
    expect(() =>
      untyped(snap, {
        source: "external",
        changes: SNAPSHOT,
        loader: () => ({ n: 1 }),
        revalidate: () => Promise.resolve("e"),
      }),
    ).toThrow(/takes no `revalidate`/);
    expect(() =>
      (liveValue as (k: string, s: unknown) => unknown)(key("rt-pre"), {
        schema: Count,
        load: "snapshot",
        preload: "boot",
      }),
    ).toThrow(/cannot be preloaded/);
  });

  test("the served value records its changes", () => {
    const served = serveValue(liveValue(key("rec"), { schema: Count }), {
      source: "external",
      changes: FIXED,
      loader: () => ({ n: 1 }),
    });
    expect(served.changes).toEqual(FIXED);
    const db = serveValue(liveValue(key("rec-db"), { schema: Count }), {
      source: "db",
      loader: () => ({ n: 1 }),
    });
    expect(db.changes).toBeUndefined();
  });
});

describe("snapshot — every HTTP read runs the loader", () => {
  test("served on demand, no ETag, one loader run per read; _debug shows the freshness", async () => {
    const runtime = createResourceRuntime();
    const v = liveValue(key("http"), { schema: Count, load: "snapshot" });
    let runs = 0;
    const { resource } = registerValue(runtime, v, {
      source: "external",
      changes: SNAPSHOT,
      loader: () => ({ n: ++runs }),
    });
    expect(resource.mode).toBe("invalidate");
    const read = async () => {
      const res = await runtime.handleResourceHttp(
        new Request(`http://x/api/resources/${v.key}`),
        { key: v.key },
      );
      expect(res.status).toBe(200);
      expect(res.headers.get("ETag")).toBeNull();
      return ((await res.json()) as { value: { n: number } }).value.n;
    };
    expect(await read()).toBe(1);
    expect(await read()).toBe(2);
    expect(await read()).toBe(3);

    const debug = await runtime.handleResourceHttp(
      new Request("http://x/api/resources/_debug"),
      { key: "_debug" },
    );
    const { resources } = (await debug.json()) as {
      resources: { key: string; freshness: unknown }[];
    };
    expect(resources.find((r) => r.key === v.key)?.freshness).toEqual({
      kind: "snapshot",
      reason: "measured on demand",
    });
  });
});
