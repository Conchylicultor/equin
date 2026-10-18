import { useConfig } from "@plugins/config_v2/web";
import {
  wallpaperConfig,
  GRADIENT_WALLPAPER_ID,
} from "@plugins/apps/plugins/desktop/plugins/wallpaper/core";
import { builtinWallpaperUrl } from "@plugins/apps/plugins/desktop/plugins/wallpaper/web";
import { useOverviewActive } from "../internal/overview";
import { layerClasses } from "@plugins/primitives/plugins/css/plugins/layer/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";

/**
 * The desktop backdrop revealed in "desktop mode" (once any tab floats). Reads
 * the GLOBAL {@link wallpaperConfig}: when a built-in is chosen it paints the bundled
 * image full-bleed; an uploaded image is served same-origin (cache-busted by
 * `version`); the gradient (or `default`) it falls
 * back to the {@link DefaultGradientBackdrop} theme-driven SVG.
 *
 * The backdrop stays NON-INTERACTIVE: both branches are `aria-hidden`, and the
 * image carries no pointer handlers. The desktop's right-click affordance is a
 * SEPARATE capture layer ({@link DesktopContextMenu}) mounted above this in the
 * floating Foreground — so the backdrop never eats clicks itself. See the plugin
 * CLAUDE.md ("the desktop is a passive backdrop, plus a context menu").
 */
export function DesktopWallpaper() {
  const { state } = useConfig(wallpaperConfig);
  const overview = useOverviewActive();
  // The mockup's `#root::before` treatment: the wallpaper recedes behind the
  // overview (blur + dim + slight zoom), with its 0.35s ease transition.
  const treatment = cn(
    "transition-[filter,transform] duration-[350ms] ease-[ease]",
    overview && "scale-[1.04] blur-[14px] brightness-[0.72] saturate-[1.1]",
  );

  if (state.kind === "image" || state.kind === "builtin") {
    // The gradient is a built-in too: drawn from the theme, not a picture.
    if (state.kind === "builtin" && state.id === GRADIENT_WALLPAPER_ID) {
      return <DefaultGradientBackdrop className={treatment} />;
    }
    const src =
      state.kind === "image"
        ? `/api/wallpaper/image?v=${state.version}`
        : builtinWallpaperUrl(state.id);
    if (!src) throw new Error(`Unknown built-in wallpaper "${state.id}"`);
    return (
      <img
        aria-hidden
        src={src}
        alt=""
        // The <img> IS the backdrop layer, so it takes the class rather than a
        // wrapping <Layer>; `size-full object-cover` crops it to the desktop.
        className={cn(
          layerClasses({ decorative: true }),
          "size-full object-cover",
          treatment,
        )}
      />
    );
  }

  return <DefaultGradientBackdrop className={treatment} />;
}

/**
 * The default, theme-driven gradient backdrop — used when no wallpaper image is
 * set. A soft mesh gradient: a diagonal color wash, two large blurred orbs for
 * depth, and one organic ribbon swoosh, finished with faint film grain so it
 * reads as a surface rather than a gradient swatch. Structure leans on the two
 * theme tokens that reliably carry contrast (`--primary`, `--accent`) so the
 * wallpaper stays legible even in near-monochrome presets while coming alive
 * with hue in vivid ones.
 *
 * Pure SVG and fully theme-aware: every color is a theme CSS variable, so it
 * re-tints for light/dark and any preset. `preserveAspectRatio="slice"` fills
 * any aspect ratio. Stays `pointer-events-none` + `aria-hidden`.
 */
function DefaultGradientBackdrop({ className }: { className?: string }) {
  return (
    <svg
      aria-hidden
      // The <svg> IS the backdrop layer (its own viewBox fills it). `<Layer
      // as="svg">` is not an option until the primitives take generic props
      // over the host element — today `viewBox`/`preserveAspectRatio` are not
      // assignable to HTMLAttributes<HTMLElement>.
      className={cn(layerClasses({ decorative: true }), "size-full", className)}
      viewBox="0 0 1600 1000"
      preserveAspectRatio="xMidYMid slice"
    >
      <defs>
        <linearGradient id="desktop-wp-wash" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.65" />
          <stop offset="55%" stopColor="var(--accent)" stopOpacity="0.12" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.16" />
        </linearGradient>
        <radialGradient id="desktop-wp-orb-a" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.55" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="desktop-wp-orb-p" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.30" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="desktop-wp-ribbon" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="var(--primary)" stopOpacity="0.22" />
          <stop offset="100%" stopColor="var(--primary)" stopOpacity="0.02" />
        </linearGradient>

        <filter
          id="desktop-wp-soft"
          x="-30%"
          y="-30%"
          width="160%"
          height="160%"
        >
          <feGaussianBlur stdDeviation="44" />
        </filter>
        <filter id="desktop-wp-grain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.8"
            numOctaves="2"
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>

      {/* Overall diagonal color wash. */}
      <rect width="100%" height="100%" fill="url(#desktop-wp-wash)" />

      {/* Large blurred orbs for depth. */}
      <circle cx="180" cy="120" r="620" fill="url(#desktop-wp-orb-a)" />
      <circle cx="1480" cy="940" r="680" fill="url(#desktop-wp-orb-p)" />

      {/* Organic ribbon swoosh. */}
      <g filter="url(#desktop-wp-soft)">
        <path
          d="M -120 520 C 420 360 980 700 1720 460 L 1720 1120 L -120 1120 Z"
          fill="url(#desktop-wp-ribbon)"
        />
      </g>

      <rect
        width="100%"
        height="100%"
        filter="url(#desktop-wp-grain)"
        opacity="0.02"
      />
    </svg>
  );
}
