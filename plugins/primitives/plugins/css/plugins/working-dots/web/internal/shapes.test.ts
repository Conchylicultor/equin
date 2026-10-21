import { describe, expect, test } from "bun:test";
import { DOT_STYLES, REST_X, type DotStyleName } from "./shapes";

/** Where each dot is drawn (x, y, scale, halo), sorted by x: the row as the eye sees it. */
function row(name: DotStyleName, p: number, a: number) {
  return REST_X.map((rest, i) => {
    const { x = 0, y = 0, s = 1, halo = 0 } = DOT_STYLES[name].pose(p, i, a);
    return [rest + x, y, s, halo].map((v) => Math.round(v * 1e6) / 1e6 + 0);
  }).sort((l, r) => l[0]! - r[0]!);
}

const resting = REST_X.map((x) => [x, 0, 1, 0]);

describe("every dot style starts and ends on the resting row", () => {
  for (const name of Object.keys(DOT_STYLES) as DotStyleName[]) {
    for (const a of [0.8, 1, 1.1]) {
      test(`${name} at amplitude ${a}`, () => {
        expect(row(name, 0, a)).toEqual(resting);
        expect(row(name, 1, a)).toEqual(resting);
      });
    }
  }
});
