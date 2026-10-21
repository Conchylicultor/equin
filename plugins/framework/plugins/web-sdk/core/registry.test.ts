import { describe, expect, it } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { createPluginRegistry, readerOf, scopedReader } from "./registry";
import { defineSlot } from "./slots";
import type { Contribution, LoadedPlugin } from "./types";

const A = defineSlot<{ id: string }>();
const B = defineSlot<{ id: string }>();

function plugin(id: string, contributions: Contribution[]): LoadedPlugin {
  return { id: asPluginId(id), description: id, contributions };
}

function setup() {
  const registry = createPluginRegistry();
  const reader = readerOf(registry);
  const calls = { a: 0, b: 0 };
  reader.subscribe(A, () => calls.a++);
  reader.subscribe(B, () => calls.b++);
  return { registry, reader, calls };
}

describe("plugin registry — per-slot notification", () => {
  it("an append notifies only the slots whose list changed, and keeps the others' arrays", () => {
    const { registry, reader, calls } = setup();
    registry.append([plugin("p1", [A({ id: "a1" }), B({ id: "b1" })])]);
    expect(calls).toEqual({ a: 1, b: 1 });
    const b = reader.read(B);
    const a = reader.read(A);

    registry.append([plugin("p2", [A({ id: "a2" })])]);
    expect(calls).toEqual({ a: 2, b: 1 });
    expect(reader.read(B)).toBe(b);
    expect(reader.read(A)).not.toBe(a);
    expect(reader.read(A).map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  it("an append that touches no slot notifies no one and keeps every array", () => {
    const { registry, reader, calls } = setup();
    registry.append([plugin("p1", [A({ id: "a1" })])]);
    const a = reader.read(A);
    registry.append([plugin("p2", [])]);
    expect(calls).toEqual({ a: 1, b: 0 });
    expect(reader.read(A)).toBe(a);
  });

  it("stamps each contribution once: its identity survives later appends", () => {
    const { registry, reader } = setup();
    registry.append([plugin("p1", [A({ id: "a1" })])]);
    const stamped = reader.read(A)[0];
    expect(stamped?._pluginId).toBe(asPluginId("p1"));
    registry.append([plugin("p2", [A({ id: "a2" })])]);
    expect(reader.read(A)[0]).toBe(stamped);
  });

  it("re-reads contributions arrays rewritten in place: same objects keep the list, a new one changes it", () => {
    const { registry, reader, calls } = setup();
    const a1 = A({ id: "a1" });
    const live: Contribution[] = [a1];
    registry.append([plugin("p1", live)]);
    const a = reader.read(A);

    live.length = 0;
    live.push(a1);
    registry.append([plugin("p2", [])]);
    expect(reader.read(A)).toBe(a);

    live.push(A({ id: "a2" }));
    registry.append([plugin("p3", [])]);
    expect(calls.a).toBe(2);
    expect(reader.read(A).map((c) => c.id)).toEqual(["a1", "a2"]);
  });

  it("an empty slot reads one stable empty list", () => {
    const { reader } = setup();
    expect(reader.read(A)).toBe(reader.read(B));
    expect(reader.read(A)).toHaveLength(0);
  });

  it("a replaced set that drops a plugin removes its contributions and notifies", () => {
    const { reader, calls } = setup();
    const p1 = plugin("p1", [A({ id: "a1" })]);
    reader.replace([p1, plugin("p2", [B({ id: "b1" })])]);
    reader.replace([p1]);
    expect(calls).toEqual({ a: 1, b: 2 });
    expect(reader.read(B)).toHaveLength(0);
  });
});

describe("scopedReader — a registry view narrowed to a plugin set", () => {
  const Wide = defineSlot<{ id: string }>({ pageWide: true });

  function scoped(plugins: string[]) {
    const registry = createPluginRegistry();
    const parent = readerOf(registry);
    registry.append([
      plugin("in", [
        A({ id: "a-in" }),
        B({ id: "b-in" }),
        Wide({ id: "w-in" }),
      ]),
      plugin("out", [A({ id: "a-out" }), Wide({ id: "w-out" })]),
    ]);
    return { registry, parent, reader: scopedReader(parent, new Set(plugins)) };
  }

  it("keeps only the contributions stamped with an in-set plugin", () => {
    const { reader } = scoped(["in"]);
    expect(reader.read(A).map((c) => c.id)).toEqual(["a-in"]);
  });

  it("returns the parent's array when nothing is filtered, and a stable array across reads", () => {
    const { parent, reader } = scoped(["in"]);
    expect(reader.read(B)).toBe(parent.read(B));
    expect(reader.read(A)).toBe(reader.read(A));
  });

  it("a filtered list changes identity only when the parent's list does", () => {
    const { registry, reader } = scoped(["in"]);
    const before = reader.read(A);
    registry.append([plugin("later", [B({ id: "b-later" })])]);
    expect(reader.read(A)).toBe(before);
    registry.append([plugin("in2", [A({ id: "a-in2" })])]);
    expect(reader.read(A)).not.toBe(before);
    expect(reader.read(A).map((c) => c.id)).toEqual(["a-in"]);
  });

  it("leaves a page-wide slot unfiltered", () => {
    const { parent, reader } = scoped(["in"]);
    expect(reader.read(Wide)).toBe(parent.read(Wide));
    expect(reader.read(Wide).map((c) => c.id)).toEqual(["w-in", "w-out"]);
  });

  it("forwards subscriptions to the parent", () => {
    const { registry, reader } = scoped(["in"]);
    let calls = 0;
    const off = reader.subscribe(A, () => calls++);
    registry.append([plugin("out2", [A({ id: "a-out2" })])]);
    expect(calls).toBe(1);
    off();
    registry.append([plugin("out3", [A({ id: "a-out3" })])]);
    expect(calls).toBe(1);
  });

  it("nested scopes intersect", () => {
    const { reader } = scoped(["in", "out"]);
    expect(reader.read(A).map((c) => c.id)).toEqual(["a-in", "a-out"]);
    const inner = scopedReader(reader, new Set(["out"]));
    expect(inner.read(A).map((c) => c.id)).toEqual(["a-out"]);
    expect(scopedReader(inner, new Set(["in"])).read(A)).toHaveLength(0);
  });

  it("declared() keeps only the slots an in-set plugin declares", () => {
    const Own = defineSlot<{ id: string }>();
    const Other = defineSlot<{ id: string }>();
    const registry = createPluginRegistry();
    registry.append([
      { ...plugin("in", []), slots: { own: Own } },
      { ...plugin("out", []), slots: { other: Other } },
    ]);
    const reader = scopedReader(readerOf(registry), new Set(["in"]));
    expect(reader.declared().map((e) => e.id)).toEqual(["in.own"]);
    expect(reader.declared()).toBe(reader.declared());
  });

  it("replace throws: the plugin set belongs to the enclosing provider", () => {
    const { reader } = scoped(["in"]);
    expect(() => reader.replace([])).toThrow(/read-only/);
  });
});
