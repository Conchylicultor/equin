/**
 * A sub waiting on an asynchronous access decision (a visitor's per-tuple
 * rule, `access.tuple`) is PENDING on its socket (`SocketState.pendingSubs`):
 * every release that arrives while it waits — `unsub`, `unsub-tab`, a
 * `sub-batch complete: true` reconciliation that does not restate it, the
 * socket's close — cancels it, so a decision landing afterwards registers
 * nothing. Before, `sub(A)` then `unsub(A)` registered A after its own unsub
 * and held it (refcount, tracking, push loads) until the socket closed.
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";
import { createHarness, tick, type Harness } from "./test-support";

const SITE: ReadonlySet<string> = new Set(["site.pages"]);

/** `docs`, open to a visitor per tuple, its rule held until `release()`. */
function defineGated(h: Harness) {
  const loaded: string[] = [];
  const held: Array<() => void> = [];
  h.runtime.defineExternalResource(
    {
      key: "docs",
      schema: z.string(),
      validateParams: () => {},
      access: { visitor: "the test page reads it" },
    },
    {
      mode: "push",
      loader: async (p: { path?: string }) => {
        loaded.push(p.path ?? "");
        return `doc:${p.path}`;
      },
      visitorTuple: () =>
        new Promise<boolean>((resolve) => held.push(() => resolve(true))),
    },
  );
  return {
    loaded,
    /** Answer every rule asked so far (open), then let the subs run on. */
    release: async () => {
      for (const r of held.splice(0)) r();
      await tick();
      await tick();
    },
  };
}

function visitorHarness(): Harness {
  return createHarness({
    principals: ["visitor"],
    visitorWebPlugins: () => SITE,
  });
}

async function subCounts(h: Harness): Promise<Record<string, number>> {
  const res = await h.runtime.handleResourceHttp(
    new Request("http://localhost/api/resources/_debug"),
    { key: "_debug" },
  );
  const debug = (await res.json()) as {
    resources: Array<{ key: string; subCounts: Record<string, number> }>;
  };
  return debug.resources.find((r) => r.key === "docs")!.subCounts;
}

describe("a sub pending on its access decision", () => {
  test("a normal sub registers and is answered once the rule answers", async () => {
    const h = visitorHarness();
    const d = defineGated(h);
    await h.subscribe("docs", { path: "a" }, { id: 1, tabId: "t" });
    expect(await subCounts(h)).toEqual({});
    await d.release();
    expect(Object.values(await subCounts(h))).toEqual([1]);
    expect(d.loaded).toEqual(["a"]);
    expect(h.frames.filter((f) => f.kind === "sub-ack")).toHaveLength(1);
  });

  test("sub then an immediate unsub: never registered, never loaded, never answered", async () => {
    const h = visitorHarness();
    const d = defineGated(h);
    await h.subscribe("docs", { path: "a" }, { id: 1, tabId: "t" });
    await h.unsub("docs", { path: "a" }, { tabId: "t" });
    await d.release();
    expect(await subCounts(h)).toEqual({});
    expect(d.loaded).toEqual([]);
    expect(h.frames.filter((f) => f.key === "docs")).toEqual([]);
  });

  test("an unsub from another tab leaves the pending sub alone", async () => {
    const h = visitorHarness();
    const d = defineGated(h);
    await h.subscribe("docs", { path: "a" }, { id: 1, tabId: "t" });
    await h.unsub("docs", { path: "a" }, { tabId: "other" });
    await d.release();
    expect(Object.values(await subCounts(h))).toEqual([1]);
  });

  test("sub then unsub-tab: never registered", async () => {
    const h = visitorHarness();
    const d = defineGated(h);
    await h.subscribe("docs", { path: "a" }, { id: 1, tabId: "t" });
    await h.subscribe("docs", { path: "b" }, { id: 2, tabId: "t" });
    await h.unsubTab("t");
    await d.release();
    expect(await subCounts(h)).toEqual({});
    expect(d.loaded).toEqual([]);
  });

  test("a complete sub-batch that does not restate it cancels it; what it restates registers", async () => {
    const h = visitorHarness();
    const d = defineGated(h);
    await h.subscribe("docs", { path: "a" }, { id: 1, tabId: "t" });
    await h.subscribeBatch([{ key: "docs", params: { path: "b" } }], {
      tabId: "t",
      complete: true,
    });
    await d.release();
    expect(d.loaded).toEqual(["b"]);
    expect(Object.values(await subCounts(h))).toEqual([1]);
  });

  test("a complete sub-batch restating it keeps it", async () => {
    const h = visitorHarness();
    const d = defineGated(h);
    await h.subscribe("docs", { path: "a" }, { id: 1, tabId: "t" });
    await h.subscribeBatch([{ key: "docs", params: { path: "a" } }], {
      tabId: "t",
      complete: true,
    });
    await d.release();
    expect(Object.values(await subCounts(h))).toEqual([1]);
  });

  test("the socket closing while it waits: never registered, nothing lingers", async () => {
    const h = visitorHarness();
    const d = defineGated(h);
    await h.subscribe("docs", { path: "a" }, { id: 1, tabId: "t" });
    h.closeSocket(0);
    await d.release();
    expect(await subCounts(h)).toEqual({});
    expect(d.loaded).toEqual([]);
  });

  test("sub, unsub, sub again: the second sub registers", async () => {
    const h = visitorHarness();
    const d = defineGated(h);
    await h.subscribe("docs", { path: "a" }, { id: 1, tabId: "t" });
    await h.unsub("docs", { path: "a" }, { tabId: "t" });
    await h.subscribe("docs", { path: "a" }, { id: 2, tabId: "t" });
    await d.release();
    expect(Object.values(await subCounts(h))).toEqual([1]);
    const acks = h.frames.filter((f) => f.kind === "sub-ack");
    expect(acks.map((f) => f.id)).toEqual([2]);
  });
});
