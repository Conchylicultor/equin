import { describe, expect, test } from "bun:test";
import { homeCarve, homeCarveGrid } from "./home";
import { WorldModel } from "./world-model";

// A bake worker builds island shapes and the home carve; the page restores
// them from the data. What the page then reads must be exactly what it would
// have built itself.
describe("shape data", () => {
  test("an island restored from another model's data reads identically", () => {
    const built = new WorldModel(7);
    const restored = new WorldModel(7);
    for (const id of [0, 1, 4]) {
      const a = built.island(id);
      const b = restored.island(id);
      // structured clone, as postMessage hands it over
      b.plan.restore(structuredClone(a.plan.data()));
      expect(b.bounds).toEqual(a.bounds);
      expect(b.shape.heart).toEqual(a.shape.heart);
      expect(b.shape.coast.length).toBe(a.shape.coast.length);
      expect(b.shape.sites(5)).toEqual(a.shape.sites(5));
      const [x0, y0, x1, y1] = a.bounds;
      for (let k = 0; k < 400; k++) {
        const x = x0 + (((k * 37) % 101) / 100) * (x1 - x0);
        const y = y0 + (((k * 53) % 97) / 96) * (y1 - y0);
        expect(restored.height(b, x, y)).toBe(built.height(a, x, y));
        expect(restored.elevation(b, x, y)).toBe(built.elevation(a, x, y));
      }
    }
  });

  test("restoring a built shape keeps the one it has", () => {
    const M = new WorldModel(3);
    const I = M.island(2);
    const shape = I.plan.build();
    expect(I.plan.restore(new WorldModel(3).island(2).plan.data())).toBe(shape);
  });

  test("the carve grid is what the carve reads", () => {
    const grid = homeCarveGrid();
    expect(grid.length).toBeGreaterThan(0);
    expect(homeCarve(-5, -5)).toBe(1);
    expect(Number.isFinite(homeCarve(1000, 1000))).toBe(true);
  });
});
