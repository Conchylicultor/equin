import { describe, expect, it } from "bun:test";
import { layoutOverview, layoutTiles } from "./overview-layout";

const box = (x: number, y: number, w = 400, h = 300) => ({ x, y, w, h });

describe("layoutOverview (mockup enterOverview)", () => {
  it("lays two windows side by side, left to right, scaled to fit", () => {
    const slots = layoutOverview(
      [
        { id: "b", box: box(600, 100) },
        { id: "a", box: box(50, 120) },
      ],
      1440,
      900,
    );
    expect(slots.map((s) => s.id)).toEqual(["a", "b"]);
    // cols = ceil(sqrt(2 * 1.6 / 1.2)) = 2; cw = (1440 - 96) / 2 = 672.
    expect(slots[0]!.rect.x + slots[0]!.rect.w / 2).toBeCloseTo(48 + 336);
    expect(slots[1]!.rect.x + slots[1]!.rect.w / 2).toBeCloseTo(48 + 672 + 336);
    // Scale never exceeds 0.9.
    for (const s of slots) expect(s.scale).toBeLessThanOrEqual(0.9);
  });

  it("reads a lower window as a later row and centres a short last row", () => {
    const slots = layoutOverview(
      [
        { id: "top-left", box: box(0, 0) },
        { id: "top-right", box: box(800, 0) },
        { id: "low", box: box(0, 500) },
      ],
      1440,
      900,
    );
    // cols = ceil(sqrt(3 * 1.6 / 1.2)) = 2 → two rows, the third alone, centred.
    expect(slots.map((s) => s.id)).toEqual(["top-left", "top-right", "low"]);
    const low = slots[2]!;
    expect(low.rect.x + low.rect.w / 2).toBeCloseTo(720);
    expect(low.label.y).toBeCloseTo(low.rect.y + low.rect.h + 10);
  });

  it("is empty without windows", () => {
    expect(layoutOverview([], 1440, 900)).toEqual([]);
  });
});

describe("layoutTiles (mockup tileAll)", () => {
  it("tiles three windows as two columns over two rows inside the gutter", () => {
    const tiles = layoutTiles(
      [
        { id: "c", box: box(900, 0) },
        { id: "a", box: box(0, 0) },
        { id: "b", box: box(400, 0) },
      ],
      1200,
      800,
      6,
    );
    const cw2 = (1200 - 18) / 2;
    const ch = (800 - 18) / 2;
    expect(tiles.get("a")).toEqual({ x: 6, y: 6, w: cw2, h: ch });
    expect(tiles.get("b")).toEqual({ x: 12 + cw2, y: 6, w: cw2, h: ch });
    // The last row holds one window, full width.
    expect(tiles.get("c")).toEqual({ x: 6, y: 12 + ch, w: 1200 - 12, h: ch });
  });
});
