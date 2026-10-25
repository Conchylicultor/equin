/**
 * Contract mismatch — a subscription whose params do not match its resource's
 * declaration (`validateParams` throws `ResourceContractError`). After a deploy
 * that is a tab running the previous bundle, so it is refused as version skew
 * instead of being registered and crash-reported on every push (the
 * `build.history` incident, research/2026-09-27-global-live-resource-skew-and-error-state.md).
 *
 * Pins:
 *   - a refused sub is never registered: a later notify runs no loader, sends no
 *     frame and files no report;
 *   - the verdict decides reporting: skew is only warned, same-build / unknown
 *     are reported;
 *   - a sub-batch leaves refused entries out (served the valid ones);
 *   - HTTP answers 404 / 409 / 500 with typed JSON bodies;
 *   - the backstop: a loader throwing `ResourceContractError` for a registered
 *     tuple evicts it everywhere and always reports.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { z } from "zod";
import { ResourceContractError } from "@plugins/packages/plugins/resource-protocol/core";
import { createHarness, tick } from "./test-support";
import type { ResourceRuntimeOptions } from "./runtime";
import { LEGACY_IDS } from "@plugins/framework/plugins/product-name/core";

/** A contract whose tuples must name `limit` — what `build.history` declares. */
function limitContract(key: string) {
  return {
    key,
    schema: z.string(),
    validateParams: (params: Record<string, string>) => {
      if (params.limit === undefined) {
        throw new ResourceContractError(key, `${key}: params.limit is missing`);
      }
    },
  };
}

function setup(opts: ResourceRuntimeOptions = {}) {
  const reported: Array<{ context: string; err: unknown }> = [];
  const h = createHarness({
    serverBuildGraph: () => "g1",
    reportError: (context, err) => reported.push({ context, err }),
    ...opts,
  });
  const loader = mock(async () => "v");
  const r = h.runtime.defineExternalResource(limitContract("hist"), {
    mode: "push",
    loader,
  });
  return { h, r, loader, reported };
}

let warn: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  warn = spyOn(console, "warn").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

describe("contract mismatch — the params gate", () => {
  test("a refused sub is never registered: a later notify runs no loader and files no report", async () => {
    const { h, r, loader, reported } = setup();
    await h.subscribe("hist", {}); // the pre-deploy bundle: no build, no limit
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({
      kind: "sub-error",
      key: "hist",
      params: {},
      reason: "contract-mismatch",
      verdict: "skew",
    });
    expect(loader).toHaveBeenCalledTimes(0);
    expect(reported).toHaveLength(0);
    expect(warn).toHaveBeenCalledTimes(1);

    r.notify({});
    await tick();
    await tick();
    expect(loader).toHaveBeenCalledTimes(0);
    expect(h.frames).toHaveLength(1);
    expect(reported).toHaveLength(0);
  });

  test("the verdict decides reporting: skew warns, same-build and unknown report", async () => {
    const cases: Array<{
      build?: string;
      server: string | null;
      verdict: string;
      reported: boolean;
    }> = [
      { build: undefined, server: "g1", verdict: "skew", reported: false },
      { build: "g0", server: "g1", verdict: "skew", reported: false },
      { build: "g1", server: "g1", verdict: "same-build", reported: true },
      { build: "dev", server: "g1", verdict: "unknown", reported: true },
      { build: "g1", server: null, verdict: "unknown", reported: true },
    ];
    for (const c of cases) {
      const { h, reported } = setup({ serverBuildGraph: () => c.server });
      await h.subscribe("hist", {}, { build: c.build });
      expect(h.frames[0]).toMatchObject({
        kind: "sub-error",
        reason: "contract-mismatch",
        verdict: c.verdict,
      });
      expect(reported.length > 0).toBe(c.reported);
      if (c.reported) {
        expect(reported[0]!.err).toBeInstanceOf(ResourceContractError);
      }
    }
  });

  test("valid params pass the gate and serve as before", async () => {
    const { h, loader } = setup();
    await h.subscribe("hist", { limit: "5" }, { build: "g1" });
    expect(h.frames[0]).toMatchObject({ kind: "sub-ack", value: "v" });
    expect(loader).toHaveBeenCalledTimes(1);
  });

  test("an unknown key carries a verdict and is not reported", async () => {
    const { h, reported } = setup();
    await h.subscribe("gone", {}, { build: "g0" });
    expect(h.frames[0]).toMatchObject({
      kind: "sub-error",
      reason: "unknown-key",
      verdict: "skew",
    });
    expect(reported).toHaveLength(0);
  });

  test("sub-batch: a refused entry is left out, the valid ones are served", async () => {
    const { h, r, loader } = setup();
    await h.subscribeBatch(
      [
        { key: "hist", params: {} },
        { key: "hist", params: { limit: "5" } },
      ],
      { build: "g0" },
    );
    const errors = h.frames.filter((f) => f.kind === "sub-error");
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      params: {},
      reason: "contract-mismatch",
      verdict: "skew",
    });
    expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(1);
    expect(loader).toHaveBeenCalledTimes(1);

    // Only the valid tuple is live: its notify pushes, the refused one never runs.
    h.frames.length = 0;
    r.notify({});
    r.notify({ limit: "5" });
    await tick();
    await tick();
    expect(loader).toHaveBeenCalledTimes(2);
    expect(h.frames.map((f) => [f.kind, f.params])).toEqual([
      ["update", { limit: "5" }],
    ]);
  });
});

describe("contract mismatch — HTTP", () => {
  const get = (
    h: ReturnType<typeof setup>["h"],
    path: string,
    build?: string,
  ) =>
    h.runtime.handleResourceHttp(
      new Request(`http://x/api/resources/${path}`, {
        headers:
          build !== undefined
            ? { [`${LEGACY_IDS.headerPrefix}build-graph`]: build }
            : {},
      }),
      { key: path.split("?")[0]! },
    );

  test("an unknown key is a 404 with a typed body", async () => {
    const { h } = setup();
    const res = await get(h, "gone", "g0");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      reason: "unknown-key",
      verdict: "skew",
    });
  });

  test("a contract failure is a 409 with its verdict, and no loader run", async () => {
    const { h, loader, reported } = setup();
    const res = await get(h, "hist");
    expect(res.status).toBe(409);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toMatchObject({
      reason: "contract-mismatch",
      verdict: "skew",
    });
    expect(loader).toHaveBeenCalledTimes(0);
    expect(reported).toHaveLength(0);

    const same = await get(h, "hist", "g1");
    expect(same.status).toBe(409);
    expect(await same.json()).toMatchObject({ verdict: "same-build" });
    expect(reported).toHaveLength(1);
  });

  test("any other loader failure is a 500 with a typed body", async () => {
    const h = createHarness({ reportError: () => {} });
    h.runtime.defineExternalResource(
      { ...limitContract("boom"), validateParams: () => {} },
      {
        mode: "push",
        loader: async () => {
          throw new Error("db down");
        },
      },
    );
    const res = await get(h, "boom");
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ reason: "loader-failed" });
  });
});

describe("contract mismatch — the backstop for a gate gap", () => {
  test("a loader refusing a registered tuple evicts it everywhere and always reports", async () => {
    const reported: unknown[] = [];
    const h = createHarness({
      sockets: 2,
      serverBuildGraph: () => "g1",
      reportError: (_c, err) => reported.push(err),
    });
    let refuse = false;
    const loader = mock(async () => {
      if (refuse) throw new ResourceContractError("gap", "gap: loader refuses");
      return "v";
    });
    // The gate lets everything through — the gap the backstop exists for.
    const r = h.runtime.defineExternalResource(
      { key: "gap", schema: z.string(), validateParams: () => {} },
      { mode: "push", loader },
    );
    await h.subscribe("gap", { q: "1" }, { socket: 0 });
    await h.subscribe("gap", { q: "1" }, { socket: 1 });
    expect(loader).toHaveBeenCalledTimes(2); // one sub-ack load per socket
    h.frames.length = 0;

    refuse = true;
    r.notify({ q: "1" });
    await tick();
    await tick();
    // Both holders told, whatever their build; reported once.
    const errors = h.frames.filter((f) => f.kind === "sub-error");
    expect(errors.map((f) => f.socket).sort()).toEqual([0, 1]);
    for (const f of errors) {
      expect(f).toMatchObject({
        reason: "contract-mismatch",
        verdict: "unknown",
      });
    }
    expect(reported).toHaveLength(1);
    expect(reported[0]).toBeInstanceOf(ResourceContractError);

    // Evicted: the next notify reruns nothing.
    const calls = loader.mock.calls.length;
    r.notify({ q: "1" });
    await tick();
    await tick();
    expect(loader.mock.calls.length).toBe(calls);
    expect(reported).toHaveLength(1);
  });
});
