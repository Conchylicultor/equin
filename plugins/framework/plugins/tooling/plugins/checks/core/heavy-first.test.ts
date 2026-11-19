import { describe, expect, test } from "bun:test";
import type { Grant } from "@plugins/infra/plugins/host/plugins/host-admission/core";
import { grantFor, passPhases } from "./heavy-first";

interface Selected {
  id: string;
  heavyChildren?: { what: string };
}
const heavy = (id: string): Selected => ({
  id,
  heavyChildren: { what: "a worker" },
});
const light = (id: string): Selected => ({ id });

describe("passPhases", () => {
  const selected = [light("a"), heavy("tc"), light("b"), heavy("layout")];

  test("a grant of one unit runs the heavy checks first, the rest after", () => {
    const { first, rest } = passPhases(selected, 1);
    expect(first.map((c) => c.id)).toEqual(["tc", "layout"]);
    expect(rest.map((c) => c.id)).toEqual(["a", "b"]);
  });

  test("a wider grant keeps one phase: every check starts at once", () => {
    const { first, rest } = passPhases(selected, 2);
    expect(first).toEqual([]);
    expect(rest.map((c) => c.id)).toEqual(["a", "tc", "b", "layout"]);
  });
});

describe("grantFor", () => {
  const grant: Grant = {
    units: 1,
    lane: "background",
    run: (fn) => fn({ units: 1, lane: "background", env: () => ({}) }),
  };

  test("a declaring check gets the run's own grant", () => {
    expect(grantFor(heavy("tc"), grant)).toBe(grant);
  });

  test("any other check's grant refuses to run a child, naming the check", () => {
    const g = grantFor(light("sneaky"), grant);
    expect(g.units).toBe(1);
    expect(g.lane).toBe("background");
    expect(g.run(() => Promise.resolve(1))).rejects.toThrow(
      /check "sneaky" spent ctx\.grant without declaring heavyChildren/,
    );
  });
});
