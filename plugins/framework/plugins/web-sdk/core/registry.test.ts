import { describe, expect, it } from "bun:test";
import { asPluginId } from "@plugins/framework/plugins/plugin-id/core";
import { createPluginRegistry, readerOf } from "./registry";
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
