/**
 * A closed key set (`ResourceRuntimeOptions.keySet` → `"closed"`) — a host that
 * ships with its only client (a browser host), so a key it does not register
 * cannot be skew.
 *
 * Pins:
 *   - closed: `sub`, `sub-batch` and the HTTP read refuse an unknown key as
 *     `unserved` (HTTP 404), with NO verdict, and report it once per refusal,
 *     naming the key;
 *   - open (the default, and an explicit `"open"`): unchanged — `unknown-key`
 *     with its skew verdict, never reported;
 *   - a registered key on a closed host serves as before.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { createHarness } from "./test-support";
import type { ResourceRuntimeOptions } from "./runtime";

function setup(opts: ResourceRuntimeOptions = {}) {
  const reported: Array<{ context: string; err: unknown }> = [];
  const h = createHarness({
    serverBuildGraph: () => "g1",
    reportError: (context, err) => reported.push({ context, err }),
    ...opts,
  });
  h.runtime.defineExternalResource(
    { key: "here", schema: z.string(), validateParams: () => {} },
    { mode: "push", loader: async () => "v" },
  );
  return { h, reported };
}

const closed = { keySet: () => "closed" as const };

function get(h: ReturnType<typeof setup>["h"], key: string) {
  return h.runtime.handleResourceHttp(
    new Request(`http://x/api/resources/${key}`, {
      headers: { "x-singularity-build-graph": "g0" },
    }),
    { key },
  );
}

let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  error.mockRestore();
});

describe("closed key set", () => {
  test("sub: an unknown key is `unserved`, no verdict, reported once naming the key", async () => {
    const { h, reported } = setup(closed);
    await h.subscribe("nope", {}, { build: "g0" });
    expect(h.frames).toHaveLength(1);
    expect(h.frames[0]).toMatchObject({
      kind: "sub-error",
      key: "nope",
      reason: "unserved",
    });
    expect(h.frames[0]).not.toHaveProperty("verdict");
    expect(reported).toHaveLength(1);
    expect(reported[0]!.context).toBe("unserved key nope");
  });

  test("sub-batch: each unknown key is `unserved` and reported, the served one acks", async () => {
    const { h, reported } = setup(closed);
    await h.subscribeBatch(
      [{ key: "nope" }, { key: "here" }, { key: "gone" }],
      { build: "g0" },
    );
    const errors = h.frames.filter((f) => f.kind === "sub-error");
    expect(errors.map((f) => [f.key, f.reason, "verdict" in f])).toEqual([
      ["nope", "unserved", false],
      ["gone", "unserved", false],
    ]);
    expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(1);
    expect(reported.map((r) => r.context)).toEqual([
      "unserved key nope",
      "unserved key gone",
    ]);
  });

  test('HTTP: an unknown key is a 404 `{ reason: "unserved" }`, reported once', async () => {
    const { h, reported } = setup(closed);
    const res = await get(h, "nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ reason: "unserved" });
    expect(reported.map((r) => r.context)).toEqual(["unserved key nope"]);
  });

  test("a registered key serves as before", async () => {
    const { h, reported } = setup(closed);
    await h.subscribe("here", {});
    expect(h.frames[0]).toMatchObject({ kind: "sub-ack", value: "v" });
    const res = await get(h, "here");
    expect(res.status).toBe(200);
    expect(reported).toHaveLength(0);
  });
});

describe("open key set", () => {
  for (const [name, opts] of [
    ["the default", {}],
    ["explicit", { keySet: () => "open" as const }],
  ] as const) {
    test(`${name}: an unknown key is \`unknown-key\` with its verdict, never reported`, async () => {
      const { h, reported } = setup(opts);
      await h.subscribe("nope", {}, { build: "g0" });
      expect(h.frames[0]).toMatchObject({
        kind: "sub-error",
        reason: "unknown-key",
        verdict: "skew",
      });
      const res = await get(h, "nope");
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        reason: "unknown-key",
        verdict: "skew",
      });
      expect(reported).toHaveLength(0);
    });
  }
});
