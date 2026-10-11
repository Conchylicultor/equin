/**
 * Tests for the level-parallel `flushNotifies` in the resource runtime. Run with
 * `bun test plugins/framework/plugins/resource-runtime/core/runtime.test.ts`.
 *
 * The flush walks the dependsOn DAG grouped by longest-path depth: entries at the
 * same depth run concurrently (Promise.all), with a barrier between depths. These
 * tests pin the behaviors that fix the head-of-line-blocking bug:
 *
 *   - DECOUPLING: a slow loader at one node does NOT delay an unrelated node's
 *     frame at the same depth — the fast frame is sent before the slow loader
 *     resolves.
 *   - CASCADE ORDERING: a downstream's frame is sent strictly after its upstream's
 *     (the depth barrier preserves "cascade settles before the deeper level drains").
 *   - VERSION MONOTONICITY: per (key,pk) the version advances by one per notify.
 *   - REENTRANCY: a notify that lands while a flush is mid-await is re-drained by
 *     the single-active-flush guard — delivered, exactly once, AFTER the in-flight
 *     flush's frames (the guard serializes; it never overlaps two flushes).
 */

import { test, expect, describe, mock, spyOn } from "bun:test";
import { z } from "zod";
import { type ExternalResource, type ResourceParams } from "./runtime";
// The harness / controllable-loader / tick helpers live in the shared
// test-support module (extracted so the invariant suites reuse the exact same
// fakes). `createHarness()` subsumes the old bespoke `harness()` (default 1
// socket), `feedHarness()` (a `readSet` option), and `revalHarness()` (subscribe
// takes an `etag`) with byte-identical behavior.
import { createHarness, controllable, tick } from "./test-support";
import { feedChange, identityPlan } from "./testing/routed-fixture";

describe("flushNotifies — level-parallel", () => {
  test("a slow loader does not head-of-line-block an unrelated fast node", async () => {
    const h = createHarness();
    const slow = controllable(0);
    const fast = controllable(0);

    const slowR = h.runtime.defineExternalResource({
      key: "slow",
      mode: "push",
      schema: z.number(),
      loader: slow.loader,
    });
    const fastR = h.runtime.defineExternalResource({
      key: "fast",
      mode: "push",
      schema: z.number(),
      loader: fast.loader,
    });

    await h.subscribe("slow");
    await h.subscribe("fast");

    // Arm the slow loader to park on its next load, then notify BOTH in the same
    // flush. `slow` and `fast` are both roots (depth 0) → same level → concurrent.
    slow.block();
    slow.setValue(1);
    fast.setValue(1);
    slowR.notify();
    fastR.notify();

    await tick();
    // Fast frame delivered while the slow loader is still parked — decoupled.
    expect(h.pushesFor("fast")).toHaveLength(1);
    expect(h.pushesFor("slow")).toHaveLength(0);

    slow.release();
    await tick();
    expect(h.pushesFor("slow")).toHaveLength(1);
  });

  test("a downstream frame is sent strictly after its upstream", async () => {
    const h = createHarness();
    const upstreamR = h.runtime.defineExternalResource({
      key: "up",
      mode: "push",
      schema: z.number(),
      loader: async () => 1,
    });
    h.runtime.defineResource({
      key: "down",
      mode: "push",
      schema: z.number(),
      loader: async () => 2,
      dependsOn: [{ resource: upstreamR }], // identity cascade, depth(down) = 1
    });

    await h.subscribe("up");
    await h.subscribe("down");

    upstreamR.notify();
    await tick();

    const up = h.pushesFor("up");
    const down = h.pushesFor("down");
    expect(up).toHaveLength(1);
    expect(down).toHaveLength(1); // cascade fired
    // Depth barrier: upstream (depth 0) sends before downstream (depth 1).
    expect(up[0]!.seq).toBeLessThan(down[0]!.seq);
  });

  // A cascade is FULL (its downstream is a legacy entry): it translates no row
  // ids, so it runs no edge query and opens no `cascade` origin — only a
  // routed entry's reverse resolve does (`runtime-table-routing.test.ts`).
  test("a cascade opens no `cascade` origin; the downstream reloads FULL under `push`", async () => {
    const origins: Array<[string, string]> = [];
    const h = createHarness({
      wrapOrigin: (kind, key, fn) => {
        origins.push([kind, key]);
        return fn();
      },
    });
    const up = h.runtime.defineExternalResource({
      key: "up",
      mode: "push",
      schema: z.number(),
      loader: async () => 1,
    });
    const downCtx: unknown[] = [];
    h.runtime.defineResource({
      key: "down",
      mode: "push",
      schema: z.number(),
      loader: async (_p, ctx) => {
        downCtx.push(ctx);
        return 2;
      },
      dependsOn: [{ resource: up }],
    });
    await h.subscribe("up");
    await h.subscribe("down");
    origins.length = 0;
    downCtx.length = 0;

    up.notify();
    await tick();

    expect(origins).toEqual([
      ["push", "up"],
      ["push", "down"],
    ]);
    expect(downCtx).toEqual([undefined]); // FULL
    expect(h.pushesFor("down")).toHaveLength(1);
  });

  test("version advances monotonically per (key,pk), one per notify", async () => {
    const h = createHarness();
    const r = h.runtime.defineExternalResource({
      key: "ver",
      mode: "push",
      schema: z.number(),
      loader: async () => 1,
    });
    await h.subscribe("ver");
    const base = h.frames.find((f) => f.kind === "sub-ack")!.version!;

    r.notify();
    await tick();
    r.notify();
    await tick();

    const sent = h.pushesFor("ver");
    expect(sent.map((f) => f.version)).toEqual([base + 1, base + 2]);
  });

  test("a notify arriving mid-flush is re-drained, once, after the in-flight flush", async () => {
    const h = createHarness();
    const slow = controllable(0);
    const slowR = h.runtime.defineExternalResource({
      key: "s",
      mode: "push",
      schema: z.number(),
      loader: slow.loader,
    });
    const fastR = h.runtime.defineExternalResource({
      key: "f",
      mode: "push",
      schema: z.number(),
      loader: async () => 1,
    });

    await h.subscribe("s");
    await h.subscribe("f");

    // Start a flush that parks on the slow loader.
    slow.block();
    slow.setValue(1);
    slowR.notify();
    await tick(); // flush is now mid-await on `s`, flushRunning = true

    // This notify lands during the in-flight flush.
    fastR.notify();
    await tick(); // the guard records flushAgain; it does NOT start a second flush

    // `f` is held back until the in-flight flush finishes (no overlap).
    expect(h.pushesFor("f")).toHaveLength(0);

    slow.release();
    await tick();

    // Both delivered, `f` exactly once, and AFTER `s` (single-active-flush order).
    expect(h.pushesFor("s")).toHaveLength(1);
    expect(h.pushesFor("f")).toHaveLength(1);
    expect(h.pushesFor("s")[0]!.seq).toBeLessThan(h.pushesFor("f")[0]!.seq);
  });
});

/**
 * A harness whose runtime is built with an injected L3 read-set hook so
 * `applyLegacyFullChange` can invert table→resource. `readSet` is a static map for the
 * test; in production it is `getReadSetIndex()[key]`. `createHarness` folds this
 * into its `ResourceRuntimeOptions` — no bespoke harness needed.
 */
const feedHarness = (readSetMap: Record<string, string[]>) =>
  createHarness({ readSet: (key) => readSetMap[key] ?? [] });

describe("applyLegacyFullChange — L4 DB change-feed routing", () => {
  test("routes a table change to a subscribed param-less resource (full recompute on INSERT)", async () => {
    const h = feedHarness({ tasks: ["tasks"] });
    h.runtime.defineResource({
      key: "tasks",
      mode: "invalidate",
      schema: z.number(),
      loader: async () => 1,
    });
    await h.subscribe("tasks");

    h.runtime.applyLegacyFullChange({
      source: "feed",
      table: "tasks",
    });
    await tick();

    expect(h.pushesFor("tasks")).toHaveLength(1);
    expect(h.pushesFor("tasks")[0]!.kind).toBe("invalidate");
  });

  test("unknown/unread table is a silent no-op", async () => {
    const h = feedHarness({ tasks: ["tasks"] });
    h.runtime.defineResource({
      key: "tasks",
      mode: "invalidate",
      schema: z.number(),
      loader: async () => 1,
    });
    await h.subscribe("tasks");

    h.runtime.applyLegacyFullChange({
      source: "feed",
      table: "unrelated_table",
    });
    await tick();

    expect(h.pushesFor("tasks")).toHaveLength(0);
  });

  test("fans out to every subscribed params tuple", async () => {
    const h = feedHarness({ doc: ["docs"] });
    h.runtime.defineResource({
      key: "doc",
      mode: "invalidate",
      schema: z.number(),
      loader: async () => 1,
    });
    await h.subscribe("doc", { id: "1" });
    await h.subscribe("doc", { id: "2" });

    h.runtime.applyLegacyFullChange({
      source: "feed",
      table: "docs",
    });
    await tick();

    // Two distinct subscribed params → two invalidate frames.
    expect(h.pushesFor("doc")).toHaveLength(2);
  });

  test("never throws: a failing lookup is reported, not thrown at the feed", () => {
    const reported: string[] = [];
    const h = createHarness({
      readSet: () => ["x_v"],
      relationBases: () => {
        throw new Error("bases not set");
      },
      reportError: (context) => reported.push(context),
    });
    h.runtime.defineResource({
      key: "x",
      mode: "push",
      schema: z.number(),
      loader: async () => 1,
    });
    const error = spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(() =>
        h.runtime.applyLegacyFullChange({ source: "feed", table: "x" }),
      ).not.toThrow();
    } finally {
      error.mockRestore();
    }
    expect(reported).toEqual(['applyLegacyFullChange failed for table "x"']);
  });

  test("notifyStatsFor counts hand vs feed sources", async () => {
    const h = feedHarness({ tasks: ["tasks"] });
    const r = h.runtime.defineExternalResource({
      key: "tasks",
      mode: "invalidate",
      schema: z.number(),
      loader: async () => 1,
    });
    await h.subscribe("tasks");

    r.notify(); // hand
    h.runtime.applyLegacyFullChange({
      source: "feed",
      table: "tasks",
    }); // feed
    await tick();

    const stats = h.runtime.notifyStatsFor("tasks");
    expect(stats.hand).toBe(1);
    expect(stats.feed).toBe(1);
  });
});

describe("defineResource(contract, serverOpts) — keyed-ness derived from the descriptor", () => {
  // A stand-in for the browser-safe client descriptor: structurally a
  // ResourceContract. The keyed identity lives HERE only — the server never
  // restates it, which is the whole point (no drift, no missing-keyOf crash).
  const rowsContract = {
    key: "rows",
    schema: z.array(z.object({ id: z.string(), n: z.number() })),
    keyed: { keyOf: (r: unknown) => (r as { id: string }).id },
    validateParams: () => {},
  };

  // A keyed contract pairs with a routed scope policy (the only keyed one).
  const routedAlias = {
    routes: identityPlan("row_table"),
    scopedMembership: {
      orderOf: async () => ["a", "b"],
      orderSignatureOf: () => "",
    },
  };

  test("a keyed contract drives a keyed delta without restating mode/keyOf", async () => {
    const h = createHarness();
    let n = 1;
    const rows = () => [
      { id: "a", n },
      { id: "b", n: 1 },
    ];
    h.runtime.defineResource(rowsContract, {
      ...routedAlias,
      loader: (_p, c) =>
        c ? rows().filter((r) => c.affectedIds.includes(r.id)) : rows(),
    });
    await h.subscribe("rows");

    n = 2;
    feedChange(h, { table: "row_table", op: "U", ids: ["a"] });
    await tick();

    const pushes = h.pushesFor("rows");
    expect(pushes).toHaveLength(1);
    // A "delta" frame proves keyed mode took effect — a non-keyed resource would
    // ship "update". So the contract's `keyed` alone configured the runtime.
    expect(pushes[0]!.kind).toBe("delta");
  });

  test("a non-keyed contract honors serverOpts.mode (push)", async () => {
    const h = createHarness();
    h.runtime.defineResource(
      { key: "n", schema: z.number(), validateParams: () => {} },
      { mode: "push", loader: async () => 1 },
    );
    await h.subscribe("n");
    // sub-ack delivers a full value frame; nothing crashes wiring a bare contract.
    expect(h.frames.some((f) => f.key === "n")).toBe(true);
  });

  // `mode` has no default: a non-keyed form must state it, and a keyed contract
  // takes none (its mode is the contract's). tsc holds typed callers to that
  // (each call below matches no overload); an untyped one is refused at
  // registration instead of getting a guessed delivery.
  test("a non-keyed form without mode, or a keyed contract with one, is refused at registration", () => {
    const { runtime } = createHarness();
    const noMode = { loader: () => 1 };
    expect(() =>
      // @ts-expect-error — a non-keyed contract's opts require `mode`
      runtime.defineResource({ key: "no-mode", schema: z.number() }, noMode),
    ).toThrow(/mode "push" \| "invalidate" is required for key "no-mode"/);
    expect(() =>
      // @ts-expect-error — the flat form requires `mode`
      runtime.defineResource({ key: "flat", schema: z.number(), ...noMode }),
    ).toThrow(/mode .* is required for key "flat"/);
    const external = { key: "no-mode-external", schema: z.number() };
    expect(() =>
      // @ts-expect-error — a non-keyed contract's opts require `mode`
      runtime.defineExternalResource(external, noMode),
    ).toThrow(/is required for key "no-mode-external"/);
    const keyedWithMode = {
      mode: "push" as const,
      ...routedAlias,
      loader: () => [],
    };
    expect(() =>
      // @ts-expect-error — a keyed contract takes no `mode`
      runtime.defineResource(rowsContract, keyedWithMode),
    ).toThrow(/a keyed contract takes no mode/);
  });
});

/**
 * Conditional revalidation (ETag / 304). Pins the additive protocol contract:
 *
 *   - A resource WITHOUT `revalidate` (or a client that sends no etag) behaves
 *     exactly as before — sub-ack carries a value and no etag.
 *   - With `revalidate` + a matching client etag, the server answers `up-to-date`
 *     (no loader run, no value) and the client keeps its cache.
 *   - A miss (or first subscribe) runs the loader and attaches a fresh etag.
 *   - The HTTP fallback honors `If-None-Match` → 304, and stamps an `ETag` header.
 */
describe("conditional revalidation (ETag / up-to-date / 304)", () => {
  // `createHarness` already captures the FULL parsed frame (value + etag) with
  // faithful key presence, and its `subscribe` takes an `etag` — so the old
  // bespoke `revalHarness` collapses to a thin `sub(key, params?, etag?)` shim
  // over it (keeps these tests' call sites unchanged).
  const revalHarness = () => {
    const h = createHarness();
    return {
      runtime: h.runtime,
      frames: h.frames,
      sub: (key: string, params: ResourceParams = {}, etag?: string) =>
        h.subscribe(key, params, etag !== undefined ? { etag } : {}),
    };
  };

  test("no revalidate: sub-ack carries value and no etag (byte-identical)", async () => {
    const h = revalHarness();
    h.runtime.defineExternalResource({
      key: "plain",
      mode: "push",
      schema: z.number(),
      loader: async () => 7,
    });
    await h.sub("plain");
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toBe(7);
    expect("etag" in ack).toBe(false);
  });

  test("first subscribe attaches a fresh etag to the sub-ack", async () => {
    const h = revalHarness();
    h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.number(),
      loader: async () => 1,
      revalidate: async () => "sig-A",
    });
    await h.sub("r"); // no client etag → loader path
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toBe(1);
    // The signature is normalized into an opaque, header-safe token (hashed), so
    // it's a non-empty string that is NOT the raw `revalidate` return.
    expect(typeof ack.etag).toBe("string");
    expect((ack.etag as string).length).toBeGreaterThan(0);
    expect(ack.etag).not.toBe("sig-A");
  });

  test("matching client etag ⇒ up-to-date, loader is NOT run", async () => {
    const h = revalHarness();
    let loads = 0;
    h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.number(),
      loader: async () => {
        loads++;
        return 1;
      },
      revalidate: async () => "sig-A",
    });
    // First subscribe (no etag) runs the loader and hands back the opaque token.
    await h.sub("r");
    const token = h.frames.find((f) => f.kind === "sub-ack")!.etag as string;
    expect(loads).toBe(1);
    h.frames.length = 0;
    // Resubscribe WITH that real token → up-to-date, loader NOT run again.
    await h.sub("r", {}, token);
    const ack = h.frames.find((f) => f.kind === "sub-ack");
    const utd = h.frames.find((f) => f.kind === "up-to-date");
    expect(ack).toBeUndefined();
    expect(utd).toBeTruthy();
    expect("value" in utd!).toBe(false);
    expect(loads).toBe(1); // the cure: no second loader for an unchanged resource
  });

  test("stale client etag ⇒ full sub-ack with the fresh etag", async () => {
    const h = revalHarness();
    let loads = 0;
    h.runtime.defineExternalResource({
      key: "r",
      mode: "push",
      schema: z.number(),
      loader: async () => {
        loads++;
        return 2;
      },
      revalidate: async () => "sig-B",
    });
    await h.sub("r", {}, "stale-token"); // client holds an OLD (non-matching) token
    const ack = h.frames.find((f) => f.kind === "sub-ack")!;
    expect(ack.value).toBe(2);
    expect(typeof ack.etag).toBe("string"); // fresh normalized token attached
    expect(ack.etag).not.toBe("stale-token");
    expect(loads).toBe(1);
  });

  test("HTTP: If-None-Match match ⇒ 304, else value + ETag header", async () => {
    const h = revalHarness();
    h.runtime.defineExternalResource({
      key: "r",
      mode: "invalidate",
      schema: z.number(),
      loader: async () => 5,
      revalidate: async () => "sig-A",
    });
    // First GET (no If-None-Match) → 200 + the opaque ETag token. Every response —
    // even the ETag-bearing ones that invite caching — forbids the browser HTTP
    // cache from storing the body (Fix A: the cache-poisoning cure).
    const first = await h.runtime.handleResourceHttp(
      new Request("http://x/api/resources/r"),
      { key: "r" },
    );
    expect(first.status).toBe(200);
    expect(first.headers.get("Cache-Control")).toBe("no-store");
    const token = first.headers.get("ETag");
    expect(token).toBeTruthy();

    // Conditional GET with the real token → 304, empty body — also no-store.
    const notModified = await h.runtime.handleResourceHttp(
      new Request("http://x/api/resources/r", {
        headers: { "If-None-Match": token! },
      }),
      { key: "r" },
    );
    expect(notModified.status).toBe(304);
    expect(notModified.headers.get("Cache-Control")).toBe("no-store");

    // A stale token → 200 with the value and the same fresh ETag — also no-store.
    const fresh = await h.runtime.handleResourceHttp(
      new Request("http://x/api/resources/r", {
        headers: { "If-None-Match": "stale" },
      }),
      { key: "r" },
    );
    expect(fresh.status).toBe(200);
    expect(fresh.headers.get("Cache-Control")).toBe("no-store");
    expect(fresh.headers.get("ETag")).toBe(token);
    expect((await fresh.json()).value).toBe(5);
  });
});

describe("authorize — deferred subscription-authorization seam", () => {
  test("absent authorize ⇒ subscription is allowed (default, sub-ack sent)", async () => {
    const h = createHarness();
    h.runtime.defineResource({
      key: "r",
      mode: "invalidate",
      schema: z.number(),
      loader: async () => 1,
    });
    await h.subscribe("r");

    const acks = h.frames.filter((f) => f.key === "r" && f.kind === "sub-ack");
    expect(acks).toHaveLength(1);
    expect(h.frames.some((f) => f.kind === "sub-error")).toBe(false);
  });

  // The WS handlers enforce `authorize` (fail-closed, sub-error/unauthorized),
  // but `handleResourceHttp` does NOT — and the client heals a sub-error via an
  // HTTP refetch, which would serve the value straight past the denial. Until
  // that parity exists, declaring the seam is refused at registration, so the
  // first real consumer hits a loud wall instead of shipping a silent
  // authorization bypass. The WS enforcement behavior (deny, per-params, throw
  // ⇒ fail closed) was pinned here until this guard landed — restore those
  // tests from history when parity ships and the guard is deleted.
  test("declaring authorize throws at registration until HTTP parity exists", () => {
    const h = createHarness();
    expect(() =>
      h.runtime.defineResource({
        key: "r",
        mode: "invalidate",
        schema: z.number(),
        loader: async () => 1,
        authorize: () => false,
      }),
    ).toThrow(/"authorize" is not enforced on the HTTP read path/);
  });
});

describe("sub-error frames — reason + params echo (Fix D)", () => {
  // Every sub-error carries `params` so the client can gate the frame on its own
  // local sub entry — a shared socket broadcasts to every tab, and a params-less
  // legacy frame would match no entry (safe drop). See notifications-client.

  test("unknown key via handleSub ⇒ sub-error/unknown-key with params echoed", async () => {
    const h = createHarness();
    await h.subscribe("nope", { id: "x" });

    const errs = h.frames.filter((f) => f.kind === "sub-error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.key).toBe("nope");
    expect(errs[0]!.reason).toBe("unknown-key");
    expect(errs[0]!.params).toEqual({ id: "x" });
  });

  test("unknown key via handleSubBatch ⇒ sub-error/unknown-key with params echoed", async () => {
    const h = createHarness();
    await h.subscribeBatch([{ key: "nope", params: { id: "y" } }]);

    const errs = h.frames.filter((f) => f.kind === "sub-error");
    expect(errs).toHaveLength(1);
    expect(errs[0]!.key).toBe("nope");
    expect(errs[0]!.reason).toBe("unknown-key");
    expect(errs[0]!.params).toEqual({ id: "y" });
  });

  test("a throwing loader ⇒ sub-error/loader-failed with params echoed", async () => {
    const reportError = mock((_ctx: string, _err: unknown) => {});
    const h = createHarness({ reportError });
    h.runtime.defineExternalResource<number, { id: string }>({
      key: "r",
      mode: "invalidate",
      schema: z.number(),
      loader: async () => {
        throw new Error("loader boom");
      },
    });
    await h.subscribe("r", { id: "z" });

    const errs = h.frames.filter(
      (f) => f.key === "r" && f.kind === "sub-error",
    );
    expect(errs).toHaveLength(1);
    expect(errs[0]!.reason).toBe("loader-failed");
    expect(errs[0]!.params).toEqual({ id: "z" });
    // The failure is still additively reported (never silently absorbed).
    expect(
      reportError.mock.calls.some(([ctx]) =>
        String(ctx).includes("loader failed for r"),
      ),
    ).toBe(true);
  });
});

describe("read-set-gap warning", () => {
  // The warning says "a hand-notify arrived that the change-feed did not cover,
  // so a table this resource reads may be missing from its read-set". That is a
  // real signal for a DB-backed resource, and always false for an external one,
  // whose hand-notify is by design its only source.
  const gapWarnings = (spy: { mock: { calls: unknown[][] } }) =>
    spy.mock.calls.filter((args) =>
      String(args[0]).includes("read-set-gap candidate"),
    );

  test("an external resource's hand-notify never warns", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = createHarness();
      const r = h.runtime.defineExternalResource({
        key: "ext",
        mode: "invalidate",
        schema: z.number(),
        loader: async () => 1,
      });
      await h.subscribe("ext");
      r.notify();
      r.notify();
      await tick();
      expect(gapWarnings(warn)).toHaveLength(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("a DB-backed resource's uncovered hand-notify still warns", async () => {
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const h = createHarness();
      const r = h.runtime.defineResource({
        key: "db",
        mode: "invalidate",
        schema: z.number(),
        loader: async () => 1,
      });
      await h.subscribe("db");
      // `notify` exists on every runtime object; the `Resource` type hides it
      // precisely so this path is not reachable from real code.
      (r as unknown as { notify: () => void }).notify();
      await tick();
      expect(gapWarnings(warn)).toHaveLength(1);
      expect(String(gapWarnings(warn)[0]![0])).toContain('"db"');
    } finally {
      warn.mockRestore();
    }
  });
});

describe("preloadedKeys — the registry's half of the preload-declare boot assert", () => {
  test("lists exactly the registered resources that declared preload, whatever the definition form", () => {
    const { runtime } = createHarness();
    // Two-arg forms: the flag rides the shared descriptor (the contract).
    runtime.defineResource(
      {
        key: "value",
        schema: z.number(),
        preload: "boot",
        validateParams: () => {},
      },
      { mode: "push", loader: () => 1 },
    );
    runtime.defineResource(
      {
        key: "keyed",
        schema: z.array(z.object({ id: z.string() })),
        keyed: { keyOf: (r: unknown) => (r as { id: string }).id },
        validateParams: () => {},
        preload: "boot-and-keep",
      },
      {
        routes: identityPlan("keyed_table"),
        scopedMembership: {
          orderOf: async () => [],
          orderSignatureOf: () => "",
        },
        loader: () => [],
      },
    );
    runtime.defineExternalResource(
      {
        key: "external",
        schema: z.number(),
        preload: "boot",
        validateParams: () => {},
      },
      { mode: "push", loader: () => 1 },
    );
    // The flat external form carries it on the definition itself.
    runtime.defineExternalResource({
      key: "external-flat",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
      preload: "boot",
    });
    // Not preloaded: absent from the list.
    runtime.defineResource({
      key: "plain",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    runtime.defineResource(
      { key: "plain-contract", schema: z.number(), validateParams: () => {} },
      { mode: "push", loader: () => 1 },
    );

    expect(runtime.preloadedKeys().sort()).toEqual([
      "external",
      "external-flat",
      "keyed",
      "value",
    ]);
  });
});

describe("applyLegacyFullChange — relation bases (C30) and the inversion memo (C38)", () => {
  // A legacy entry reading a VIEW is indexed under the view's bases, so a
  // write to a table feeding the view reaches it — once, however many of its
  // relations share that base.
  test("a reader of a view is reached by a write to each of its bases, once", async () => {
    const h = createHarness({
      readSet: (key) => (key === "v" ? ["tasks_v", "attempts_v"] : []),
      relationBases: (r) =>
        r === "tasks_v"
          ? ["attempts", "conversations", "tasks"]
          : r === "attempts_v"
            ? ["attempts", "conversations"]
            : [r],
    });
    let loads = 0;
    h.runtime.defineResource({
      key: "v",
      mode: "push",
      schema: z.number(),
      loader: async () => ++loads,
    });
    await h.subscribe("v");
    const at = loads;

    h.runtime.applyLegacyFullChange({ source: "feed", table: "conversations" });
    await tick();
    expect(loads - at).toBe(1);

    h.runtime.applyLegacyFullChange({ source: "feed", table: "tasks" });
    await tick();
    expect(loads - at).toBe(2);

    // The view's own name and an unrelated table reach nothing.
    h.runtime.applyLegacyFullChange({ source: "feed", table: "tasks_v" });
    h.runtime.applyLegacyFullChange({ source: "feed", table: "pushes" });
    await tick();
    expect(loads - at).toBe(2);
  });

  // The inversion is memoized on the read-set version: an unchanged version
  // reuses it (no relation is re-expanded), and installing new bases — which
  // moves the version (server-core's `setRelationBases`, D33) — rebuilds it
  // through them.
  test("the memo hits on an unchanged version and misses after the bases change", async () => {
    let version = 0;
    let expansions = 0;
    let bases: (r: string) => readonly string[] = (r) => [r];
    const h = createHarness({
      readSet: (key) => (key === "v" ? ["tasks_v"] : []),
      readSetVersion: () => version,
      relationBases: (r) => {
        expansions++;
        return bases(r);
      },
    });
    let loads = 0;
    h.runtime.defineResource({
      key: "v",
      mode: "push",
      schema: z.number(),
      loader: async () => ++loads,
    });
    await h.subscribe("v");
    const at = loads;

    // Identity bases: a `tasks` write does not reach the reader of `tasks_v`.
    h.runtime.applyLegacyFullChange({ source: "feed", table: "tasks" });
    await tick();
    expect(loads - at).toBe(0);
    const built = expansions;
    expect(built).toBe(1);

    // Unchanged version: the memo serves, nothing is re-expanded.
    h.runtime.applyLegacyFullChange({ source: "feed", table: "tasks" });
    h.runtime.applyLegacyFullChange({ source: "feed", table: "attempts" });
    await tick();
    expect(expansions).toBe(built);

    // `setRelationBases`: new bases AND a moved version.
    bases = (r) => (r === "tasks_v" ? ["attempts", "tasks"] : [r]);
    version++;
    h.runtime.applyLegacyFullChange({ source: "feed", table: "tasks" });
    await tick();
    expect(expansions).toBe(built + 1);
    expect(loads - at).toBe(1);
  });
});

// P8 step 23b: the legacy scope policy, the keyed external resource and the
// DB-backed cascade upstream have no spelling any more (tsc); each is still
// refused at registration for a caller a cast let through, so a dead option is
// loud instead of silently doing nothing.
describe("P8 23b — the deleted spellings are refused at registration", () => {
  const rowsContract = {
    key: "rows",
    schema: z.array(z.object({ id: z.string() })),
    keyed: { keyOf: (r: unknown) => (r as { id: string }).id },
    validateParams: () => {},
  };
  const routedAlias = {
    routes: identityPlan("row_table"),
    scopedMembership: { orderOf: async () => [], orderSignatureOf: () => "" },
    loader: () => [],
  };

  test("D37: a legacy scope key cast through either form throws, naming it", () => {
    const { runtime } = createHarness();
    expect(() =>
      runtime.defineResource(rowsContract, {
        ...routedAlias,
        ...({ identityTable: "row_table" } as object),
      }),
    ).toThrow(
      /"identityTable" on key "rows" — the legacy scope policy is gone/,
    );
    expect(() =>
      runtime.defineResource({
        key: "flat",
        mode: "push",
        schema: z.number(),
        loader: () => 1,
        ...({ recompute: { kind: "full", reason: "x" } } as object),
      }),
    ).toThrow(/"recompute" on key "flat"/);
    expect(() =>
      runtime.defineExternalResource(
        { key: "ext", schema: z.number(), validateParams: () => {} },
        {
          mode: "push",
          loader: () => 1,
          ...({ fanOut: { reason: "x" } } as object),
        },
      ),
    ).toThrow(/defineExternalResource: "fanOut" on key "ext"/);
    // Positive control: the same routed alias without the cast registers.
    expect(() =>
      runtime.defineResource(rowsContract, routedAlias),
    ).not.toThrow();
  });

  test("D31: a keyed entry is a membership entry — routed when DB-backed, an external window otherwise; keyed-without-membership throws", () => {
    const { runtime } = createHarness();
    const noScope = { loader: () => [] };
    expect(() =>
      // @ts-expect-error — a keyed external contract requires the window arm
      runtime.defineExternalResource(rowsContract, noScope),
    ).toThrow(
      /a keyed entry is a membership entry — key "rows" declares no membership/,
    );
    // The external window: no routes, no point set / alias, no windowIdsOf.
    const ext = (key: string) => ({ ...rowsContract, key });
    expect(() =>
      runtime.defineExternalResource(ext("ext-point"), {
        membership: { kind: "point", idsOf: () => [] },
        loader: () => [],
      } as never),
    ).toThrow(/an external keyed entry is a bounded window/);
    expect(() =>
      runtime.defineExternalResource(ext("ext-ids"), {
        membership: {
          kind: "window",
          limitOf: () => 3,
          windowIdsOf: async () => [],
        },
        loader: () => [],
      } as never),
    ).toThrow(/an external keyed entry is a bounded window/);
    expect(() =>
      runtime.defineExternalResource(ext("ext-alias"), {
        scopedMembership: { orderOf: async () => [] },
        loader: () => [],
      } as never),
    ).toThrow(/an external keyed entry is a bounded window/);
    // Positive control: the window arm registers, keyed.
    const win = runtime.defineExternalResource(ext("ext-window"), {
      membership: { kind: "window", limitOf: () => 3 },
      loader: () => [],
    });
    expect(win.mode).toBe("keyed");
    // D32: nothing cascades out of the window (its drain cascades nothing),
    // in either registration order.
    expect(() =>
      runtime.defineExternalResource({
        key: "follows-window",
        mode: "push",
        schema: z.number(),
        loader: () => 1,
        dependsOn: [{ resource: win }],
      }),
    ).toThrow(/"follows-window" cascades from the keyed window "ext-window"/);
    runtime.defineExternalResource({
      key: "follows-late",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
      dependsOn: [
        {
          resource: { key: "late-window" } as unknown as ExternalResource<
            unknown,
            ResourceParams
          >,
        },
      ],
    });
    expect(() =>
      runtime.defineExternalResource(ext("late-window"), {
        membership: { kind: "window", limitOf: () => 3 },
        loader: () => [],
      }),
    ).toThrow(/"follows-late" cascades from the keyed window "late-window"/);
    const flatKeyed = {
      key: "flat-keyed",
      mode: "keyed" as const,
      schema: z.array(z.object({ id: z.string() })),
      keyOf: (r: { id: string }) => r.id,
      loader: () => [],
    };
    expect(() =>
      // @ts-expect-error — the flat external form is push / invalidate only
      runtime.defineExternalResource(flatKeyed),
    ).toThrow(/key "flat-keyed" declares no membership/);
    expect(() =>
      // @ts-expect-error — a keyed contract requires the routed ScopePolicy
      runtime.defineResource(rowsContract, noScope),
    ).toThrow(/key "rows" declares no membership/);
  });

  test("T15: a dependsOn onto a DB-backed upstream throws in both registration orders; an external one registers", () => {
    const { runtime } = createHarness();
    const db = runtime.defineResource({
      key: "db",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    expect(() =>
      runtime.defineResource({
        key: "down",
        mode: "push",
        schema: z.number(),
        loader: () => 2,
        // @ts-expect-error — a DB-backed `Resource` has no notify: not an upstream
        dependsOn: [{ resource: db }],
      }),
    ).toThrow(/"down" dependsOn "db", which is DB-backed/);

    // The other order: the downstream names an upstream registered after it.
    runtime.defineResource({
      key: "early",
      mode: "push",
      schema: z.number(),
      loader: () => 2,
      dependsOn: [
        {
          resource: { key: "late" } as unknown as ExternalResource<
            unknown,
            ResourceParams
          >,
        },
      ],
    });
    expect(() =>
      runtime.defineResource({
        key: "late",
        mode: "push",
        schema: z.number(),
        loader: () => 1,
      }),
    ).toThrow(/"early" dependsOn "late", which is DB-backed/);

    // Positive control: an external upstream cascades.
    const ext = runtime.defineExternalResource({
      key: "ext",
      mode: "push",
      schema: z.number(),
      loader: () => 1,
    });
    expect(() =>
      runtime.defineResource({
        key: "down-ok",
        mode: "push",
        schema: z.number(),
        loader: () => 2,
        dependsOn: [{ resource: ext }],
      }),
    ).not.toThrow();
  });

  test("T15: a deferred placeholder upstream is left to its bind, which refuses it", () => {
    const { runtime } = createHarness();
    const deferredValue = runtime.defineDeferredResource(
      { key: "deferred", schema: z.number(), validateParams: () => {} },
      () => ({ mode: "push" as const, loader: () => 1 }),
    );
    // Before the bind the placeholder reports `externalSource: false` like any
    // DB-backed entry, so registration does not judge it…
    expect(() =>
      runtime.defineResource({
        key: "down",
        mode: "push",
        schema: z.number(),
        loader: () => 2,
        dependsOn: [
          {
            resource: deferredValue as unknown as ExternalResource<
              unknown,
              ResourceParams
            >,
          },
        ],
      }),
    ).not.toThrow();
    // …and the bind, which makes it a DB-backed value, refuses the cascade.
    expect(() => runtime.bindDeferredResources()).toThrow(
      /"down" dependsOn "deferred", which is DB-backed/,
    );
  });

  // `notify` has no row-id spelling (tsc); a hand notify is always a FULL
  // recompute. A25 (`scheduleNotify` refusing row ids for a non-membership
  // entry) has no public path left to reach it, so it is not exercised here.
  test("Resource.notify takes no row ids (type); an external notify recomputes FULL", async () => {
    const h = createHarness();
    const ctxs: unknown[] = [];
    const r = h.runtime.defineExternalResource({
      key: "ext",
      mode: "push",
      schema: z.number(),
      loader: (_p, ctx) => {
        ctxs.push(ctx);
        return 1;
      },
    });
    await h.subscribe("ext");
    ctxs.length = 0;
    // @ts-expect-error — the deleted `{ affectedIds }` option has no spelling.
    r.notify({}, { affectedIds: ["a"] });
    await tick();
    expect(ctxs).toEqual([undefined]);
    expect(h.pushesFor("ext")).toHaveLength(1);
  });
});
