/**
 * Refusals — a loader throwing `ResourceRefusal` (an expected, caller-caused
 * "this question cannot be answered as asked"). Pins:
 *   - the sub-ack read sends `sub-error reason:"refused"` WITH the code and
 *     the message;
 *   - the HTTP read answers 422 `{ reason: "refused", code, detail }`;
 *   - a push drain whose loader refuses tells every holder the same
 *     `sub-error reason:"refused"` (a change INTO a refused state reaches the
 *     reader), sends no update, and reports nothing;
 *   - neither files a report (it is not a server failure);
 *   - a code the resource does not declare (`refusals`) is a server bug:
 *     `loader-failed`, reported, never `refused`;
 *   - any other loader throw is unchanged: `loader-failed`, reported.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { z } from "zod";
import { ResourceRefusal } from "@plugins/packages/plugins/resource-protocol/core";
import { createHarness } from "./test-support";

class UnknownThing extends ResourceRefusal {
  constructor(message: string) {
    super("unknown-thing", message);
  }
}

function setup(
  fail: () => never,
  refusals: readonly string[] | undefined = ["unknown-thing"],
) {
  const reported: unknown[] = [];
  const h = createHarness({ reportError: (_c, err) => reported.push(err) });
  h.runtime.defineExternalResource(
    {
      key: "q",
      schema: z.string(),
      validateParams: () => {},
      ...(refusals !== undefined ? { refusals } : {}),
    },
    { mode: "push", loader: async () => fail() },
  );
  return { h, reported };
}

const refuse = (): never => {
  throw new UnknownThing('unknown metric "x"');
};
const refuseUndeclared = (): never => {
  throw new ResourceRefusal("gone", "it went away");
};
const crash = (): never => {
  throw new Error("db down");
};

let info: ReturnType<typeof spyOn>;
let error: ReturnType<typeof spyOn>;
beforeEach(() => {
  info = spyOn(console, "info").mockImplementation(() => {});
  error = spyOn(console, "error").mockImplementation(() => {});
});
afterEach(() => {
  info.mockRestore();
  error.mockRestore();
});

const get = (h: ReturnType<typeof setup>["h"]) =>
  h.runtime.handleResourceHttp(new Request("http://x/api/resources/q"), {
    key: "q",
  });

describe("refusal", () => {
  test("WS: the sub-error is `refused` with the code and message, and nothing is reported", async () => {
    const { h, reported } = setup(refuse);
    await h.subscribe("q", {});
    expect(h.frames.at(-1)).toMatchObject({
      kind: "sub-error",
      key: "q",
      reason: "refused",
      code: "unknown-thing",
      message: 'unknown metric "x"',
    });
    expect(reported).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });

  test("HTTP: a 422 with the code and the message as `detail`, and nothing is reported", async () => {
    const { h, reported } = setup(refuse);
    const res = await get(h);
    expect(res.status).toBe(422);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      reason: "refused",
      code: "unknown-thing",
      detail: 'unknown metric "x"',
    });
    expect(reported).toEqual([]);
  });

  test("an undeclared code is a server bug: loader-failed, reported, on both paths", async () => {
    for (const refusals of [["unknown-thing"], undefined]) {
      const { h, reported } = setup(refuseUndeclared, refusals);
      await h.subscribe("q", {});
      const frame = h.frames.at(-1) as unknown as Record<string, unknown>;
      expect(frame).toMatchObject({
        kind: "sub-error",
        reason: "loader-failed",
      });
      expect("code" in frame).toBe(false);
      const res = await get(h);
      expect(res.status).toBe(500);
      expect(await res.json()).toEqual({ reason: "loader-failed" });
      expect(reported).toHaveLength(2);
      const err = reported[0] as Error;
      expect(err.message).toContain('code "gone"');
      expect(err.cause).toBeInstanceOf(ResourceRefusal);
    }
  });

  test("any other throw is unchanged: loader-failed, reported", async () => {
    const { h, reported } = setup(crash);
    await h.subscribe("q", {});
    const frame = h.frames.at(-1) as unknown as Record<string, unknown>;
    expect(frame).toMatchObject({ kind: "sub-error", reason: "loader-failed" });
    expect("message" in frame).toBe(false);
    const res = await get(h);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ reason: "loader-failed" });
    expect(reported).toHaveLength(2);
  });

  test("push drain: a refusal after a notify reaches every holder as `refused`, with no update", async () => {
    const reported: unknown[] = [];
    const h = createHarness({
      sockets: 2,
      reportError: (_c, err) => reported.push(err),
    });
    let gone = false;
    const resource = h.runtime.defineExternalResource(
      {
        key: "f",
        schema: z.string(),
        validateParams: () => {},
        refusals: ["unknown-thing"],
      },
      {
        mode: "push",
        loader: async () => {
          if (gone) throw new UnknownThing("the file was deleted");
          return "contents";
        },
      },
    );
    await h.subscribe("f", {}, { socket: 0 });
    await h.subscribe("f", {}, { socket: 1 });
    const before = h.frames.length;
    gone = true;
    resource.notify();
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
    const after = h.frames.slice(before) as unknown as Record<
      string,
      unknown
    >[];
    expect(after.filter((f) => f.kind === "update")).toEqual([]);
    const errors = after.filter((f) => f.kind === "sub-error");
    expect(errors).toHaveLength(2);
    for (const f of errors) {
      expect(f).toMatchObject({
        key: "f",
        params: {},
        reason: "refused",
        code: "unknown-thing",
        message: "the file was deleted",
      });
    }
    expect(reported).toEqual([]);
  });
});
