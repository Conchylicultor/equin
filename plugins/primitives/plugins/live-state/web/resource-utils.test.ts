/**
 * Tests for the pure readiness combinators. `useCombinedResources` /
 * `<ResourceView>` are thin shells over these; testing the pure functions
 * locks the load-bearing invariants: the three states and their precedence
 * (error > loading > ready), per-key data mapping, first-error propagation,
 * `foldResource`'s explicit per-state answers, `mapResource`'s pass-through of
 * the loading and error arms, the needsMachine `unavailable` arm (precedence
 * error > unavailable > loading, passed through, folded only by a handler the
 * type requires), and acceptance of any `status`-named input
 * (`useOptimisticResource`'s result — the named exemption — included).
 */

import { test, expect, describe } from "bun:test";
import { ResourceError, type ResourceUnavailable } from "../core";
import {
  combineResources,
  foldResource,
  mapResource,
  refuseResource,
  statusOf,
} from "./resource-utils";
import type { ResourceResult } from "./use-resource";

const refetch = () => Promise.resolve();
const ready = <T>(data: T): ResourceResult<T> => ({
  status: "ready",
  data,
  refetch,
});
const loading = <T>(): ResourceResult<T> => ({
  status: "loading",
  refetch,
});
const failed = <T>(error: ResourceError, stale?: T): ResourceResult<T> =>
  stale === undefined
    ? { status: "error", error, refetch }
    : { status: "error", error, stale, refetch };

const boom = new ResourceError("loader-failed", "boom", null);
const unavailable = (message = "not here"): ResourceUnavailable => ({
  status: "unavailable",
  message,
});
/** A needsMachine read's result type: the read's arms plus `unavailable`. */
type MachineRead<T> = ResourceResult<T> | ResourceUnavailable;
/** Widen to the machine-read type (a typed `const` would narrow on assignment). */
const asMachine = <T>(r: MachineRead<T>): MachineRead<T> => r;

describe("combineResources", () => {
  test("loading until every input is ready", () => {
    expect(combineResources({ a: ready([1]), b: loading() }).status).toBe(
      "loading",
    );
    expect(combineResources({ a: loading(), b: loading() }).status).toBe(
      "loading",
    );
  });

  test("ready with per-key data once all inputs are ready", () => {
    const r = combineResources({ a: ready([1, 2]), b: ready("x") });
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.data.a).toEqual([1, 2]);
    expect(r.data.b).toBe("x");
    expect(r.status).toBe("ready");
  });

  test("precedence: error > loading > ready — one failure fails the combine even while others load", () => {
    const r = combineResources({ a: failed(boom), b: loading(), c: ready(1) });
    expect(r.status).toBe("error");
    if (r.status !== "error") throw new Error("unreachable");
    expect(r.error).toBe(boom);
  });

  test("carries the FIRST failed input's error", () => {
    const second = new ResourceError("transport", "later", null);
    const r = combineResources({ a: failed(boom), b: failed(second) });
    if (r.status !== "error") throw new Error("unreachable");
    expect(r.error).toBe(boom);
  });

  test("accepts an optimistic-shaped ready input (status + data + extras)", () => {
    const optimistic = {
      status: "ready" as const,
      data: { ranks: [] },
      dispatch: () => "op",
    };
    const r = combineResources({ q: optimistic, other: ready(0) });
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.data.q).toEqual({ ranks: [] });
  });

  test("an error input carrying a plain Error has it wrapped as loader-failed", () => {
    const plain = new Error("legacy");
    const r = combineResources({ a: { status: "error", error: plain } });
    if (r.status !== "error") throw new Error("unreachable");
    expect(r.error).toBeInstanceOf(ResourceError);
    expect(r.error.kind).toBe("loader-failed");
    expect(r.error.message).toBe("legacy");
    expect(r.error.cause).toBe(plain);
  });

  test("refetch refetches every input that can", async () => {
    let calls = 0;
    const counting = (): ResourceResult<number> => ({
      status: "loading",
      refetch: () => {
        calls++;
        return Promise.resolve();
      },
    });
    await combineResources({ a: counting(), b: counting() }).refetch();
    expect(calls).toBe(2);
  });

  test("precedence: error > unavailable > loading — a failure still wins", () => {
    const r = combineResources({ a: unavailable(), b: failed(boom) });
    expect(r.status).toBe("error");
  });

  test("an unavailable input makes the combine unavailable, even while others load", () => {
    const r = combineResources({
      a: loading(),
      b: unavailable("first"),
      c: unavailable("second"),
      d: ready(1),
    });
    expect(r.status).toBe("unavailable");
    if (r.status !== "unavailable") throw new Error("unreachable");
    expect(r.message).toBe("first");
  });

  test("the unavailable arm is in the type only when an input carries it", () => {
    const portable = combineResources({ a: ready(1) });
    // @ts-expect-error -- no input can be unavailable, so neither can the combine
    void (portable.status === "unavailable");
    const machine = asMachine<number>(ready(1));
    const withArm = combineResources({ a: machine });
    expect(withArm.status === "unavailable").toBe(false);
  });

  test("empty input set is ready", () => {
    expect(combineResources({}).status).toBe("ready");
  });
});

describe("statusOf", () => {
  test("reads `status`", () => {
    expect(statusOf(ready(1))).toBe("ready");
    expect(statusOf(loading())).toBe("loading");
    expect(statusOf(failed(boom))).toBe("error");
  });
});

describe("foldResource", () => {
  const handlers = {
    loading: () => "loading",
    error: (e: ResourceError, stale: number[] | undefined) =>
      `error:${e.kind}:${stale === undefined ? "none" : stale.length}`,
    ready: (rows: number[]) => `ready:${rows.length}`,
  };

  test("names what every state yields", () => {
    expect(foldResource(loading<number[]>(), handlers)).toBe("loading");
    expect(foldResource(ready([1, 2]), handlers)).toBe("ready:2");
    expect(foldResource(failed<number[]>(boom), handlers)).toBe(
      "error:loader-failed:none",
    );
    expect(foldResource(failed(boom, [1, 2, 3]), handlers)).toBe(
      "error:loader-failed:3",
    );
  });
});

describe("foldResource — unavailable", () => {
  test("a needsMachine read folds through its required unavailable handler", () => {
    const r = asMachine<number[]>(unavailable("needs the computer"));
    expect(
      foldResource(r, {
        loading: () => "loading",
        error: () => "error",
        ready: (rows) => `ready:${rows.length}`,
        unavailable: (message) => `unavailable:${message}`,
      }),
    ).toBe("unavailable:needs the computer");
  });

  test("the handler is required exactly when the input carries the arm", () => {
    const r = asMachine<number[]>(ready([1]));
    // @ts-expect-error -- `unavailable` is missing for a needsMachine read
    foldResource(r, {
      loading: () => 0,
      error: () => 0,
      ready: (rows) => rows.length,
    });
    foldResource(ready([1]), {
      loading: () => 0,
      error: () => 0,
      ready: (rows) => rows.length,
      // @ts-expect-error -- a portable read has no unavailable arm to handle
      unavailable: () => 0,
    });
  });
});

describe("mapResource", () => {
  test("passes the unavailable arm through", () => {
    const r = asMachine<number[]>(unavailable("away"));
    const m = mapResource(r, (xs) => xs.length);
    // The same arm object, passed through (not rebuilt).
    expect(m as unknown).toBe(r);
    const ok = asMachine<number[]>(ready([1, 2]));
    const mapped = mapResource(ok, (xs) => xs.length);
    if (mapped.status !== "ready") throw new Error("unreachable");
    expect(mapped.data).toBe(2);
  });

  test("maps the ready arm and a stale value; passes loading and error through", () => {
    const len = (xs: number[]) => xs.length;
    const r = mapResource(ready([1, 2]), len);
    if (r.status !== "ready") throw new Error("unreachable");
    expect(r.data).toBe(2);

    expect(mapResource(loading<number[]>(), len).status).toBe("loading");

    const e = mapResource(failed(boom, [1, 2, 3]), len);
    if (e.status !== "error") throw new Error("unreachable");
    expect(e.error).toBe(boom);
    expect(e.stale).toBe(3);

    const noStale = mapResource(failed<number[]>(boom), len);
    if (noStale.status !== "error") throw new Error("unreachable");
    expect("stale" in noStale).toBe(false);
  });
});

describe("refuseResource", () => {
  test("passes the unavailable arm through", () => {
    const r = asMachine<number[]>(unavailable());
    expect(refuseResource(r, () => boom)).toBe(r);
  });

  const tooMany = (xs: number[]) =>
    xs.length > 2 ? new ResourceError("loader-failed", "too many", null) : null;

  test("a refused ready value is the error arm, the value kept as stale", () => {
    const r = refuseResource(ready([1, 2, 3]), tooMany);
    expect(r.status).toBe("error");
    if (r.status !== "error") return;
    expect(r.error.message).toBe("too many");
    expect(r.stale).toEqual([1, 2, 3]);
    expect(r.refetch).toBe(refetch);
  });

  test("an accepted ready value, loading and error pass through untouched", () => {
    const ok = ready([1]);
    expect(refuseResource(ok, tooMany)).toBe(ok);
    const l = loading<number[]>();
    expect(refuseResource(l, tooMany)).toBe(l);
    const e = failed<number[]>(boom);
    expect(refuseResource(e, tooMany)).toBe(e);
  });
});
