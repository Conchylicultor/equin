import { sha256Hex } from "@plugins/packages/plugins/string-hash/core";
import { LOGO } from "./geometry";
import { logoSvg, type LogoSvgOptions } from "./svg";

/**
 * Every file generated from the logo — read by something that cannot import
 * it: the page's static favicons (`web-core/web/index.html`) and the native
 * helper's icons (`menu-bar/rust/build.rs`). Written by `scripts/render.ts`,
 * held in sync by the `logo:files-in-sync` check. Paths are repo-relative.
 */
export type LogoFile =
  | { path: string; kind: "svg"; svg: LogoSvgOptions }
  /** A rasterized `svg` entry (named by its path), `px` square. */
  | { path: string; kind: "png"; from: string; px: number };

const WEB = "plugins/framework/plugins/web-core/web/public";
const HELPER = "plugins/menu-bar/rust/icons";

export const LOGO_FILES: readonly LogoFile[] = [
  {
    path: `${WEB}/icon.svg`,
    kind: "svg",
    svg: { master: "full", paint: "gradient", size: 120 },
  },
  {
    path: `${WEB}/icon-small.svg`,
    kind: "svg",
    svg: { master: "small", paint: "gradient", size: 32 },
  },
  {
    path: `${WEB}/icon_16x16.png`,
    kind: "png",
    from: `${WEB}/icon-small.svg`,
    px: 16,
  },
  {
    path: `${WEB}/icon_32x32.png`,
    kind: "png",
    from: `${WEB}/icon-small.svg`,
    px: 32,
  },
  {
    path: `${WEB}/icon_512x512.png`,
    kind: "png",
    from: `${WEB}/icon.svg`,
    px: 512,
  },
  // The macOS app icon: the full logo on a white tile.
  {
    path: `${HELPER}/app.svg`,
    kind: "svg",
    svg: {
      master: "full",
      paint: "gradient",
      size: 512,
      tile: { fill: "#ffffff", inset: 4, radius: 21, scale: 0.7 },
    },
  },
  // The tray icon, one ink (build.rs folds it to a template image or a light one).
  {
    path: `${HELPER}/tray.svg`,
    kind: "svg",
    svg: { master: "small", paint: "currentColor", size: 44 },
  },
  {
    path: `${HELPER}/tray-attention.svg`,
    kind: "svg",
    svg: {
      master: "small",
      paint: "currentColor",
      size: 44,
      // build.rs folds the dot's colour (its ACCENT) into the template image too.
      attention: {
        knockout: { cx: 84, cy: 16, r: 22 },
        dotRadius: 14,
        dotFill: LOGO.gradient.from,
      },
    },
  },
];

/** The SVG text an `svg` entry must hold. */
export function logoFileSvg(path: string): string {
  const file = LOGO_FILES.find((f) => f.path === path);
  if (file?.kind !== "svg")
    throw new Error(`${path} is not a generated logo SVG.`);
  return logoSvg(file.svg);
}

/** The PNG text key a rendered PNG carries its source digest under. */
export const LOGO_PNG_SOURCE_KEY = "equin-logo-source";

/** What a `png` entry was rendered from: its source SVG's text and its size. */
export function logoPngSourceDigest(
  file: Extract<LogoFile, { kind: "png" }>,
): string {
  return sha256Hex(`${logoFileSvg(file.from)}@${file.px}`);
}
