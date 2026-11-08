import { Resvg } from "@resvg/resvg-js";
import {
  appIcon,
  appIconToSvg,
  appTileFill,
} from "@plugins/apps-core/plugins/app-icon/core";
import type { AppRef } from "@plugins/primitives/plugins/pane/core";
import { manifestSymbolBody } from "@plugins/ui/plugins/icons/plugins/sprites/machine";

// Rendered PNGs, by app and size. The inputs (the generated app set, the
// installed icon sets) only change with a new build, which restarts the
// process, so an entry never goes stale; the set is bounded by apps × the
// sizes asked for (the route's three, a shim iconset's seven). A failed render
// is not kept: the next request renders again (and fails loudly again).
const cache = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

/**
 * One app's icon as a PNG: its glyph (the installed Material Symbols set, the
 * default icon style) in white on its launcher tile colour, a rounded square —
 * the same picture the rail and the launchers draw, for a consumer with no CSS
 * (an installed web app's OS icon, a native shim's icon file).
 */
export function appIconPng(
  app: AppRef,
  size: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isInteger(size) || size <= 0) {
    throw new Error(
      `An icon size is a positive whole pixel count, not ${size}.`,
    );
  }
  const key = `${app.id}:${size}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  // Copied into an ArrayBuffer of its own: resvg hands back a Node Buffer
  // (any ArrayBufferLike), which a Response body does not take. The icon draws
  // no text, so no font is loaded (lint `no-resvg-system-fonts`).
  const png = appIconSvg(app, size)
    .then(
      (svg) =>
        new Uint8Array(
          new Resvg(svg, {
            fitTo: { mode: "width", value: size },
            font: { loadSystemFonts: false },
          })
            .render()
            .asPng(),
        ),
    )
    .catch((err: unknown) => {
      cache.delete(key);
      throw err;
    });
  cache.set(key, png);
  return png;
}

/**
 * The SVG {@link appIconPng} rasterizes, at `size` px (1024 by default) — the
 * icon's picture as text, so a caller can tell whether an icon it wrote
 * earlier is still current without rendering one (a shim's fingerprint).
 *
 * The glyph is the manifest's default-style drawing, from the sprites' one
 * pass over the icon sets — never a parse of the ~19 MB sets per icon (which
 * made every menu-bar catalog read parse them once per app).
 */
export async function appIconSvg(app: AppRef, size = 1024): Promise<string> {
  return appIconToSvg(await manifestSymbolBody(app.icon.name), {
    size,
    background: appTileFill(
      appIcon(app.icon, { color: app.iconColor }),
      app.id,
    ),
    foreground: "#ffffff",
  });
}
