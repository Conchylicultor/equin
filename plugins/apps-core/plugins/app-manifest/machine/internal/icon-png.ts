import { Resvg } from "@resvg/resvg-js";
import {
  appIcon,
  appIconToSvg,
  appTileFill,
} from "@plugins/apps-core/plugins/app-icon/core";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import { symbolBody } from "@plugins/ui/plugins/icons/server";

// Rendered PNGs, by app and size. The inputs (the generated app set, the
// installed icon sets) only change with a new build, which restarts the
// process, so an entry never goes stale; the set is bounded by apps × the
// sizes asked for (the route's three, a shim iconset's seven).
const cache = new Map<string, Uint8Array<ArrayBuffer>>();

/**
 * One app's icon as a PNG: its glyph (the installed Material Symbols set, the
 * default icon style) in white on its launcher tile colour, a rounded square —
 * the same picture the rail and the launchers draw, for a consumer with no CSS
 * (an installed web app's OS icon, a native shim's icon file).
 */
export function appIconPng(app: AppRef, size: number): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(
      `An icon size is a positive whole pixel count, not ${size}.`,
    );
  }
  const key = `${app.id}:${size}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // Copied into an ArrayBuffer of its own: resvg hands back a Node Buffer
  // (any ArrayBufferLike), which a Response body does not take.
  const png = new Uint8Array(
    new Resvg(appIconSvg(app, size), { fitTo: { mode: "width", value: size } })
      .render()
      .asPng(),
  );
  cache.set(key, png);
  return png;
}

/**
 * The SVG {@link appIconPng} rasterizes, at `size` px (1024 by default) — the
 * icon's picture as text, so a caller can tell whether an icon it wrote
 * earlier is still current without rendering one (a shim's fingerprint).
 */
export function appIconSvg(app: AppRef, size = 1024): string {
  return appIconToSvg(symbolBody(app.icon.name), {
    size,
    background: appTileFill(
      appIcon(app.icon, { color: app.iconColor }),
      app.id,
    ),
    foreground: "#ffffff",
  });
}
