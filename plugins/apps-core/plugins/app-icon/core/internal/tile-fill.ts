import {
  AVATAR_COLOR_NAMES,
  avatarColorPick,
} from "@plugins/primitives/plugins/avatar/core";
import { Color } from "@plugins/primitives/plugins/css/plugins/color-picker/core";
import type { AppIcon } from "../index";
import { APP_TILE_PALETTE } from "./tile-palette";

/** The lightness a tile's second shade adds (the avatar primitive's `-lift`). */
const SHADE_LIFT = 0.13;

const OKLCH = /^oklch\(([\d.]+) ([\d.]+) ([\d.]+)\)$/;

/**
 * The colour an app's launcher tile is painted, as sRGB hex — for a painter
 * with no CSS (the server's icon PNGs, a web-app manifest's theme colour). The
 * same pick the web tile makes (`avatarColorPick`: the declared colour, else
 * one derived from the app id) over the same {@link APP_TILE_PALETTE}, so the
 * PNG and the rail draw one colour.
 */
export function appTileFill(icon: AppIcon, appId: string): string {
  const pick = avatarColorPick(icon.color, appId);
  if (pick === null) {
    // Unreachable for a non-empty id: the id always seeds a colour.
    throw new Error(`appTileFill: app id "${appId}" picks no tile colour`);
  }
  const slot = AVATAR_COLOR_NAMES.indexOf(pick.slot) + 1;
  const css =
    APP_TILE_PALETTE[`categorical-${slot}` as keyof typeof APP_TILE_PALETTE];
  const m = OKLCH.exec(css);
  if (!m) throw new Error(`appTileFill: unparseable palette value "${css}"`);
  const l = Number(m[1]) + (pick.shade === 1 ? SHADE_LIFT : 0);
  return Color.fromOklch(l, Number(m[2]), Number(m[3])).fitted().toHex();
}
