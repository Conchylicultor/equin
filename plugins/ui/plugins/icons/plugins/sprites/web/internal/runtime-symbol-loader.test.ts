import { describe, expect, it } from "bun:test";
import type { StyleKey } from "@plugins/ui/plugins/icons/core";
import { MAX_RUNTIME_SYMBOLS_PER_READ } from "../../core";
import { createRuntimeSymbolLoader } from "./runtime-symbol-loader";

const K: StyleKey = "default-outline-400";
const R: StyleKey = "rounded-outline-400";

function harness() {
  let pending: (() => void) | null = null;
  const loader = createRuntimeSymbolLoader((flush) => {
    expect(pending).toBeNull();
    pending = flush;
  });
  let notified = 0;
  loader.subscribe(() => notified++);
  const frame = () => {
    const f = pending;
    pending = null;
    f?.();
  };
  const shape = () =>
    loader.batches().map((b) => ({ styleKey: b.styleKey, names: b.names }));
  return { loader, frame, shape, notified: () => notified };
}

describe("createRuntimeSymbolLoader", () => {
  it("batches every want of a frame into one sorted batch per style key", () => {
    const h = harness();
    h.loader.request({ styleKey: K, name: "rocket" });
    h.loader.request({ styleKey: K, name: "home" });
    h.loader.request({ styleKey: R, name: "home" });
    expect(h.shape()).toEqual([]);
    h.frame();
    expect(h.shape()).toEqual([
      { styleKey: K, names: ["home", "rocket"] },
      { styleKey: R, names: ["home"] },
    ]);
    expect(h.notified()).toBe(1);
  });

  it("dedupes within a batch and never re-batches a wanted name", () => {
    const h = harness();
    h.loader.request({ styleKey: K, name: "home" });
    h.loader.request({ styleKey: K, name: "home" });
    h.frame();
    h.loader.request({ styleKey: K, name: "home" });
    h.frame();
    expect(h.shape()).toEqual([{ styleKey: K, names: ["home"] }]);
  });

  it("leaves earlier batches untouched when a later frame adds one", () => {
    const h = harness();
    h.loader.request({ styleKey: K, name: "home" });
    h.frame();
    const [first] = h.loader.batches();
    h.loader.request({ styleKey: K, name: "rocket" });
    h.frame();
    expect(h.loader.batches()[0]).toBe(first);
    expect(h.shape()).toEqual([
      { styleKey: K, names: ["home"] },
      { styleKey: K, names: ["rocket"] },
    ]);
  });

  it("splits a batch past the read's cap", () => {
    const h = harness();
    for (let i = 0; i < MAX_RUNTIME_SYMBOLS_PER_READ + 5; i++) {
      h.loader.request({ styleKey: K, name: `n${String(i).padStart(4, "0")}` });
    }
    h.frame();
    expect(h.shape().map((b) => b.names.length)).toEqual([
      MAX_RUNTIME_SYMBOLS_PER_READ,
      5,
    ]);
  });

  it("drops a landed batch, so only in-flight batches are read", () => {
    const h = harness();
    h.loader.request({ styleKey: K, name: "home" });
    h.loader.request({ styleKey: R, name: "home" });
    h.frame();
    const [first] = h.loader.batches();
    h.loader.landed(first!.chunkId);
    expect(h.shape()).toEqual([{ styleKey: R, names: ["home"] }]);
    expect(h.notified()).toBe(2);
    h.loader.landed(first!.chunkId);
    expect(h.notified()).toBe(2);
  });
});
