import { describe, expect, test } from "bun:test";
import {
  BUILTIN_WALLPAPERS,
  DEFAULT_WALLPAPER_ID,
  GRADIENT_WALLPAPER_ID,
  getBuiltinWallpaper,
  isDefaultWallpaper,
} from "./builtin";

describe("builtin wallpapers", () => {
  test("ids are unique and the default and gradient exist", () => {
    const ids = BUILTIN_WALLPAPERS.map((w) => w.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(getBuiltinWallpaper(DEFAULT_WALLPAPER_ID)).toBeDefined();
    expect(
      getBuiltinWallpaper(GRADIENT_WALLPAPER_ID)?.attribution,
    ).toBeUndefined();
  });

  test("every picture carries a full credit", () => {
    for (const w of BUILTIN_WALLPAPERS) {
      if (w.id === GRADIENT_WALLPAPER_ID) continue;
      expect(w.attribution?.creator).toBeTruthy();
      expect(w.attribution?.sourceUrl).toMatch(/^https:/);
    }
  });

  test("isDefaultWallpaper", () => {
    expect(isDefaultWallpaper({ kind: "builtin", id: "elarun" })).toBe(true);
    expect(isDefaultWallpaper({ kind: "builtin", id: "opal" })).toBe(false);
    expect(isDefaultWallpaper({ kind: "default", id: "elarun" })).toBe(false);
  });
});
