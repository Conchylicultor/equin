import { Resvg } from "@resvg/resvg-js";
import {
  appIcon,
  appIconToSvg,
  appTileFill,
} from "@plugins/apps-core/plugins/app-icon/core";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import { symbolBody } from "@plugins/ui/plugins/icons/server";
import type { AppIconSize } from "../../core";

// Rendered PNGs, by app and size. The inputs (the generated app set, the
// installed icon sets) only change with a new build, which restarts the
// process, so an entry never goes stale; the set is bounded by apps × sizes.
const cache = new Map<string, Uint8Array<ArrayBuffer>>();

/**
 * One app's icon as a PNG: its glyph (the installed Material Symbols set, the
 * default icon style) in white on its launcher tile colour, a rounded square —
 * the same picture the rail and the launchers draw, for a consumer with no CSS
 * (an installed web app's OS icon, a native shim's icon file).
 */
export function appIconPng(
  app: AppRef,
  size: AppIconSize,
): Uint8Array<ArrayBuffer> {
  const key = `${app.id}:${size}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const svg = appIconToSvg(symbolBody(app.icon.name), {
    size,
    background: appTileFill(
      appIcon(app.icon, { color: app.iconColor }),
      app.id,
    ),
    foreground: "#ffffff",
  });
  // Copied into an ArrayBuffer of its own: resvg hands back a Node Buffer
  // (any ArrayBufferLike), which a Response body does not take.
  const png = new Uint8Array(
    new Resvg(svg, { fitTo: { mode: "width", value: size } }).render().asPng(),
  );
  cache.set(key, png);
  return png;
}
