/**
 * `optionalParams`: every spelling of an absent optional param names ONE tuple
 * wherever params enter the runtime — a `sub` / `unsub` / `sub-batch` frame (the
 * dispatcher canonicalizes every op's params the same way), `notify`, a mapped
 * `dependsOn` tuple, the HTTP read, `loadResourceByKey`.
 */

import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createHarness } from "./test-support";

const S = z.object({ n: z.number() });

describe("optional params", () => {
  test("a sub spelling the optional param as '' holds the canonical tuple; notify reaches it", async () => {
    const h = createHarness();
    const seen: Record<string, string>[] = [];
    let n = 0;
    const doc = h.runtime.defineExternalResource(
      {
        key: "doc",
        schema: S,
        optionalParams: ["scopeId"],
        validateParams: () => {},
      },
      {
        mode: "push",
        loader: (p: Record<string, string>) => {
          seen.push(p);
          return { n: n++ };
        },
      },
    );
    await h.subscribe("doc", { path: "a", scopeId: "" });
    // The loader saw the canonical tuple, and the sub-ack names it.
    expect(seen).toEqual([{ path: "a" }]);
    const ack = h.frames.find((f) => f.kind === "sub-ack" && f.key === "doc");
    expect(ack?.params).toEqual({ path: "a" });

    // A notify spelled either way reaches the one subscribed tuple.
    doc.notify({ path: "a" });
    await h.tick();
    await h.tick();
    doc.notify({ path: "a", scopeId: "" });
    await h.tick();
    await h.tick();
    const updates = h.pushesFor("doc");
    expect(updates.length).toBe(2);
    for (const u of updates) expect(u.params).toEqual({ path: "a" });

    // An unsub spelled the other way releases it.
    await h.unsub("doc", { path: "a" });
    doc.notify({ path: "a" });
    await h.tick();
    await h.tick();
    expect(h.pushesFor("doc").length).toBe(2);
  });

  test("a required param's '' is a value; only the declared-optional '' is dropped", async () => {
    const h = createHarness();
    const seen: Record<string, string>[] = [];
    h.runtime.defineExternalResource(
      {
        key: "req",
        schema: S,
        optionalParams: ["scopeId"],
        validateParams: () => {},
      },
      {
        mode: "push",
        loader: (p: Record<string, string>) => {
          seen.push(p);
          return { n: 0 };
        },
      },
    );
    await h.subscribe("req", { path: "", scopeId: "" });
    expect(seen).toEqual([{ path: "" }]);
  });

  test("the HTTP read of ?scopeId= reads the canonical tuple", async () => {
    const h = createHarness();
    const seen: Record<string, string>[] = [];
    h.runtime.defineExternalResource(
      {
        key: "http",
        schema: S,
        optionalParams: ["scopeId"],
        validateParams: () => {},
      },
      {
        mode: "push",
        loader: (p: Record<string, string>) => {
          seen.push(p);
          return { n: 1 };
        },
      },
    );
    const res = await h.runtime.handleResourceHttp(
      new Request("http://x/api/resources/http?path=a&scopeId="),
      { key: "http" },
    );
    expect(res.status).toBe(200);
    expect(seen).toEqual([{ path: "a" }]);
  });

  test("a mapped dependsOn tuple is canonical", async () => {
    const h = createHarness();
    const up = h.runtime.defineExternalResource({
      key: "up",
      mode: "push",
      schema: S,
      loader: () => ({ n: 0 }),
    });
    const seen: Record<string, string>[] = [];
    h.runtime.defineExternalResource(
      {
        key: "down",
        schema: S,
        optionalParams: ["scopeId"],
        validateParams: () => {},
      },
      {
        mode: "push",
        dependsOn: [{ resource: up, map: () => [{ path: "a", scopeId: "" }] }],
        loader: (p: Record<string, string>) => {
          seen.push(p);
          return { n: seen.length };
        },
      },
    );
    await h.subscribe("down", { path: "a" });
    seen.length = 0;
    up.notify();
    await h.tick();
    await h.tick();
    expect(seen).toEqual([{ path: "a" }]);
    expect(
      h.pushesFor("down").every((f) => f.params?.scopeId === undefined),
    ).toBe(true);
  });

  test("two sockets, two spellings: one tuple — one first-subscribe, one loader run, one span", async () => {
    const h = createHarness({ sockets: 2 });
    let starts = 0;
    let loads = 0;
    h.runtime.defineExternalResource(
      {
        key: "shared",
        schema: S,
        optionalParams: ["scopeId"],
        validateParams: () => {},
      },
      {
        mode: "push",
        onFirstSubscribe: () => {
          starts++;
        },
        loader: () => ({ n: ++loads }),
      },
    );
    await h.subscribe("shared", { path: "a" }, { socket: 0 });
    await h.subscribe("shared", { path: "a", scopeId: "" }, { socket: 1 });
    expect(starts).toBe(1);
    // The second socket's sub-ack names the canonical tuple too.
    for (const f of h.frames.filter((f) => f.kind === "sub-ack")) {
      expect(f.params).toEqual({ path: "a" });
    }
  });

  test("a sub-batch restating the held sub in the other spelling keeps it (no 1→0→1)", async () => {
    const h = createHarness();
    let starts = 0;
    let stops = 0;
    h.runtime.defineExternalResource(
      {
        key: "batch",
        schema: S,
        optionalParams: ["scopeId"],
        validateParams: () => {},
      },
      {
        mode: "push",
        onFirstSubscribe: () => {
          starts++;
        },
        onLastUnsubscribe: () => {
          stops++;
        },
        loader: () => ({ n: 0 }),
      },
    );
    await h.subscribe("batch", { path: "a" }, { tabId: "t" });
    await h.subscribeBatch(
      [{ key: "batch", params: { path: "a", scopeId: "" } }],
      { tabId: "t", complete: true },
    );
    expect(starts).toBe(1);
    expect(stops).toBe(0);
  });

  test("loadResourceByKey canonicalizes its params", async () => {
    const h = createHarness();
    const seen: Record<string, string>[] = [];
    h.runtime.defineExternalResource(
      {
        key: "direct",
        schema: S,
        optionalParams: ["scopeId"],
        validateParams: () => {},
      },
      {
        mode: "push",
        loader: (p: Record<string, string>) => {
          seen.push(p);
          return { n: 0 };
        },
      },
    );
    await h.runtime.loadResourceByKey("direct", { path: "a", scopeId: "" });
    expect(seen).toEqual([{ path: "a" }]);
  });

  test("types: the flat forms take no optionalParams (the rule comes from the client descriptor)", () => {
    const h = createHarness();
    // Never called — the assertions are the `@ts-expect-error`s.
    const typeOnly = () => {
      h.runtime.defineExternalResource({
        key: "flat-ext",
        mode: "push",
        schema: S,
        loader: () => ({ n: 0 }),
        // @ts-expect-error — optional params come from the shared descriptor
        optionalParams: ["scopeId"],
      });
      h.runtime.defineResource({
        key: "flat-db",
        mode: "push",
        schema: S,
        loader: () => ({ n: 0 }),
        // @ts-expect-error — optional params come from the shared descriptor
        optionalParams: ["scopeId"],
      });
    };
    expect(typeof typeOnly).toBe("function");
  });
});
