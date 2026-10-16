import { expect, test } from "bun:test";
import type { MapPin } from "@plugins/map/core";
import { clusterItemId, hitTest, planPins, type PlanInput } from "./plan";

function pin(id: string, x: number, rank?: number): MapPin {
  return {
    kind: "pin",
    id,
    pinType: "t",
    // The test's world point reads lng as x; lat stays 0.
    position: { lat: 0, lng: x },
    ...(rank === undefined ? {} : { rank }),
  };
}

const base = (pins: MapPin[]): PlanInput => ({
  pins,
  crowd: undefined,
  zoom: 10,
  world: (p) => ({ x: p.position.lng, y: 0 }),
  activeId: null,
  hoveredId: null,
});

test("without a crowd mode every pin is its own near item, stacked by rank", () => {
  const items = planPins(base([pin("a", 0, 1), pin("b", 0)]));
  expect(items.map((i) => [i.id, i.kind, i.kind === "pin" && i.scale])).toEqual(
    [
      ["a", "pin", "near"],
      ["b", "pin", "near"],
    ],
  );
  const z = new Map(items.map((i) => [i.id, i.z]));
  expect(z.get("a")!).toBeGreaterThan(z.get("b")!);
});

test("far spots: the lead carries the count, draws above non-leads, and a hover hushes it", () => {
  const input: PlanInput = {
    ...base([pin("a", 0, 1), pin("b", 10), pin("c", 500)]),
    crowd: { kind: "spots", radiusPx: 34, nearZoom: 13 },
  };
  const items = planPins(input);
  const a = items.find((i) => i.id === "a");
  expect(a?.kind === "pin" && a.scale).toBe("far");
  expect(a?.kind === "pin" && a.spot).toEqual({ count: 2, hushed: false });
  const b = items.find((i) => i.id === "b")!;
  const c = items.find((i) => i.id === "c")!;
  expect(b.kind === "pin" && b.spot).toBeUndefined();
  expect(a!.z).toBeGreaterThan(c.z);
  const hovered = planPins({ ...input, hoveredId: "b" });
  const lead = hovered.find((i) => i.id === "a");
  expect(lead?.kind === "pin" && lead.spot?.hushed).toBe(true);
});

test("spots at the near zoom are near pins with no counts; the active pin tops them all", () => {
  const items = planPins({
    ...base([pin("a", 0, 5), pin("b", 1)]),
    crowd: { kind: "spots", radiusPx: 34, nearZoom: 10 },
    activeId: "b",
  });
  expect(
    items.every((i) => i.kind === "pin" && i.scale === "near" && !i.spot),
  ).toBe(true);
  const z = new Map(items.map((i) => [i.id, i.z]));
  expect(z.get("b")!).toBeGreaterThan(z.get("a")!);
});

test("clusters merge neighbours, never the active pin", () => {
  const items = planPins({
    ...base([pin("a", 0), pin("b", 5), pin("c", 8), pin("d", 900)]),
    crowd: { kind: "cluster", radiusPx: 48 },
    activeId: "c",
  });
  const cluster = items.find((i) => i.kind === "cluster");
  expect(cluster?.id).toBe(clusterItemId("a"));
  expect(cluster?.kind === "cluster" && cluster.pins.map((p) => p.id)).toEqual([
    "a",
    "b",
  ]);
  expect(
    items
      .filter((i) => i.kind === "pin")
      .map((i) => i.id)
      .sort(),
  ).toEqual(["c", "d"]);
});

test("a hit lands on the topmost box containing the point", () => {
  const boxes = [
    { id: "low", left: 0, top: 0, width: 10, height: 10, z: 1 },
    { id: "high", left: 5, top: 5, width: 10, height: 10, z: 2 },
  ];
  expect(hitTest(boxes, 7, 7)?.id).toBe("high");
  expect(hitTest(boxes, 2, 2)?.id).toBe("low");
  expect(hitTest(boxes, 30, 30)).toBeNull();
});
