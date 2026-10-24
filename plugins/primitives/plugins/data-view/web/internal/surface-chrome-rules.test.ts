import { describe, expect, it } from "bun:test";
import {
  assertSurfaceChrome,
  type SurfaceChrome,
} from "./surface-chrome-rules";

const band: SurfaceChrome = {
  hosted: false,
  sectioned: false,
  overlay: false,
  aside: undefined,
  asideEnd: undefined,
  backdrop: undefined,
  reserve: undefined,
};
const overlay: SurfaceChrome = { ...band, overlay: true };
const check = (chrome: SurfaceChrome) => () => assertSurfaceChrome("t", chrome);

describe("assertSurfaceChrome", () => {
  it("takes an asideEnd beside an overlay band only", () => {
    expect(check({ ...overlay, asideEnd: "panel" })).not.toThrow();
    expect(check({ ...band, asideEnd: "panel" })).toThrow(/asideEnd/);
    expect(check({ ...band, hosted: true, asideEnd: "panel" })).toThrow(
      /asideEnd/,
    );
  });

  it("takes a reserve beside a backdrop or an asideEnd", () => {
    const reserve = { right: "300px" };
    expect(check({ ...overlay, reserve })).toThrow(/reserve/);
    expect(check({ ...overlay, reserve, backdrop: "map" })).not.toThrow();
    expect(check({ ...overlay, reserve, asideEnd: "panel" })).not.toThrow();
  });

  it("keeps the aside and backdrop rules", () => {
    expect(check({ ...band, sectioned: true, aside: "a" })).toThrow(/aside/);
    expect(check({ ...band, backdrop: "map" })).toThrow(/backdrop/);
    expect(check({ ...band, aside: "a" })).not.toThrow();
  });
});
