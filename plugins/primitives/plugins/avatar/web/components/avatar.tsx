import {
  cn,
  useControlSize,
  type ControlSize,
  type DensityControlled,
} from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { forwardRef, type CSSProperties } from "react";
import {
  runtimeSymbol,
  type IconRef,
  type SavedSymbolName,
} from "@plugins/ui/plugins/icons/core";
import { Icon } from "@plugins/ui/plugins/icons/web";
import { avatarColorPick, type AvatarShape } from "../../core";
import {
  AVATAR_FILL_FLAT_CLASS,
  AVATAR_FILL_SOFT_CLASS,
  AVATAR_FILL_SOLID_CLASS,
  avatarFlatClass,
  avatarGradientClass,
  avatarSoftClass,
  avatarSolidClass,
} from "../internal/colors";
import {
  useAvatarPresentation,
  type AvatarPresentation,
} from "../internal/presentation";

export interface AvatarProps extends DensityControlled {
  /**
   * The saved icon — a Material Symbols name the user picked — drawn as a
   * runtime symbol in the surrounding theme's icon style.
   */
  icon?: SavedSymbolName | null;
  color?: string | null;
  /**
   * A CSS colour from outside the categorical palette — a domain's own theme
   * token (`var(--place-food)`), for a surface whose colours carry meaning of
   * their own. Wins over `color` and the auto-colour; `colorless` still wins.
   */
  fill?: string;
  /**
   * A glyph named in code (an app's icon), drawn when there is no saved `icon`.
   * Not persisted.
   */
  symbol?: IconRef | null;
  /** Box outline. Defaults to `circle`. */
  shape?: AvatarShape;
  /** Tailwind bg class for an overlaid status dot (Slack-style presence). */
  statusDot?: string | null;
  /** Used as a stable key for the deterministic color fallback when `color` is null. */
  fallbackKey?: string;
  /**
   * Single character rendered centered when there is no icon, so the disc is
   * never blank. Only the first char is used, uppercased. Providing this also
   * tints the disc via the deterministic auto-color (from `fallbackKey`) unless
   * an explicit `color` is set or `colorless` is true.
   */
  fallbackGlyph?: string;
  /** Force a neutral (muted) disc, ignoring `color` and the auto-color fallback. */
  colorless?: boolean;
  className?: string;
  title?: string;
}

interface Geometry {
  box: string;
  icon: string;
  /** Font size of the fallback letter, as a share of the box's height (`cqh` —
   *  the box is a size container). The letter is part of the disc's geometry,
   *  like the icon, never a text role: a role would follow the theme's type
   *  scale while the box stays put. */
  glyph: string;
  dot: string;
  ring: string;
}

// The box is a density token per tier (`avatarXs` … `avatarLg`, defaults
// 16 / 24 / 32 / 48px), so a theme sizes avatars the way it sizes controls.
// Everything inside is a SHARE of the box, never a fixed size, so a theme that
// picks 22px keeps the disc's proportions: the letter in `cqh` (the box is a
// size container), the icon and the status dot in `%` of the box, and the dot's
// overhang in `%` of the box too. The shares reproduce the old fixed sizes
// exactly at the default boxes; a share that is a repeating fraction (7/12,
// 1/3, 1/24) is written rounded UP, because layout snaps a length down to
// 1/64px and `calc(100% / 3)` of 24px drew a 7.98px dot.
//
// They are not one ratio per part: a small disc needs a relatively larger
// letter and glyph to stay legible (letter 10px in 16px, 12 in 24, 14 in 32,
// 16 in 48; icon 10 / 14 / 16 / 24px), and a relatively larger dot (6 / 8 / 10
// / 12px, hanging 1 / 1 / 2 / 2px past the edge).
const SIZE_MAP: Record<ControlSize, Geometry> = {
  xs: {
    box: "size-avatar-xs",
    icon: "size-[62.5%]",
    glyph: "text-[length:62.5cqh]",
    dot: "size-[37.5%] -right-[6.25%] -bottom-[6.25%]",
    ring: "ring-1",
  },
  sm: {
    box: "size-avatar-sm",
    icon: "size-[58.334%]",
    glyph: "text-[length:50cqh]",
    dot: "size-[33.334%] -right-[4.167%] -bottom-[4.167%]",
    ring: "ring-2",
  },
  md: {
    box: "size-avatar-md",
    icon: "size-[50%]",
    glyph: "text-[length:43.75cqh]",
    dot: "size-[31.25%] -right-[6.25%] -bottom-[6.25%]",
    ring: "ring-2",
  },
  lg: {
    box: "size-avatar-lg",
    icon: "size-[50%]",
    glyph: "text-[length:33.333cqh]",
    dot: "size-[25%] -right-[4.167%] -bottom-[4.167%]",
    ring: "ring-2",
  },
};

/** Tile geometry: the box fills the host-sized parent, so the glyph (svg, or
 *  the letter) is 46% of it; the dot carries no ring. */
const TILE_GEOMETRY: Geometry = {
  box: "size-full",
  icon: "size-[46%]",
  glyph: "text-[length:46cqh]",
  dot: "size-[18%] right-[4%] bottom-[4%]",
  ring: "",
};

/** Tile relief: the flat fill lit from above — a white→black veil over the
 *  slot (lighter top, deeper bottom, no hue drift, so the tile stays its own
 *  colour), a hairline lit top edge and rim that hold its shape on a dark page,
 *  and a faint shadow under the glyph so it sits on the surface. */
const TILE_RELIEF =
  "bg-linear-to-b from-white/12 to-black/12 shadow-[inset_0_1px_0_oklch(1_0_0/18%),inset_0_0_0_1px_oklch(1_0_0/6%)] [&>svg]:drop-shadow-[0_1px_1.5px_oklch(0_0_0/28%)]";

/** Gradient-tile geometry: the tile's box with a larger glyph (54%, the
 *  share an app icon's glyph takes on a store card), and its relief — a 1px
 *  inset highlight along the top edge and a soft drop shadow. */
const GRADIENT_TILE_GEOMETRY: Geometry = {
  ...TILE_GEOMETRY,
  icon: "size-[54%]",
};
const GRADIENT_TILE_RELIEF =
  "shadow-[inset_0_1px_0_oklch(1_0_0/25%),0_10px_20px_-10px_oklch(0_0_0/80%)]";

const SHAPE_CLASS: Record<AvatarShape, string> = {
  circle: "rounded-full",
  squircle: "rounded-squircle",
};

function geometryFor(
  presentation: AvatarPresentation,
  size: ControlSize,
): Geometry {
  if (presentation === "tile") return TILE_GEOMETRY;
  if (presentation === "gradient-tile") return GRADIENT_TILE_GEOMETRY;
  return SIZE_MAP[size];
}

export const Avatar = forwardRef<HTMLSpanElement, AvatarProps>(function Avatar(
  {
    icon,
    color,
    fill,
    symbol,
    shape = "circle",
    statusDot,
    fallbackKey,
    fallbackGlyph,
    colorless,
    className,
    title,
  },
  ref,
) {
  const size = useControlSize();
  const presentation = useAvatarPresentation();
  const sz = geometryFor(presentation, size);
  const drawn: IconRef | null =
    icon != null ? runtimeSymbol(icon) : (symbol ?? null);
  const glyph = fallbackGlyph ? fallbackGlyph.charAt(0).toUpperCase() : null;
  const custom = !colorless && fill !== undefined;
  const filled =
    !colorless && (drawn != null || color != null || glyph != null);
  const pick =
    filled && !custom
      ? avatarColorPick(color, fallbackKey ?? icon ?? undefined)
      : null;
  const paint = custom
    ? presentation === "tile"
      ? cn(AVATAR_FILL_FLAT_CLASS, TILE_RELIEF)
      : presentation === "gradient-tile"
        ? cn(AVATAR_FILL_FLAT_CLASS, GRADIENT_TILE_RELIEF)
        : presentation === "solid-badge"
          ? AVATAR_FILL_SOLID_CLASS
          : AVATAR_FILL_SOFT_CLASS
    : presentation === "tile"
      ? cn(avatarFlatClass(pick), pick && TILE_RELIEF)
      : presentation === "gradient-tile"
        ? cn(avatarGradientClass(pick), GRADIENT_TILE_RELIEF)
        : presentation === "solid-badge"
          ? avatarSolidClass(pick)
          : avatarSoftClass(pick);
  // leading-none keeps the fallback glyph optically centered; its font size is
  // the geometry's share of the box (see Geometry.glyph), not text hierarchy.
  // A solid badge's letter is bold: cut out of a solid disc, a medium stroke
  // reads thin.
  const glyphWeight =
    presentation === "solid-badge" ? "font-bold" : "font-medium";
  // The letter's box is trimmed to its CAP HEIGHT over its baseline
  // (`text-box: trim-both cap alphabetic`), so the disc's flex centring
  // centres the capital's ink. `leading-none` alone centres the font's em box,
  // whose ascent and descent are unequal (Inter: the capital sits ~1px low in
  // a 24px disc). A browser without `text-box` keeps the em-box centring.
  // eslint-disable-next-line text/no-adhoc-typography -- see above
  const glyphClass = cn(
    glyphWeight,
    "leading-none [text-box:trim-both_cap_alphabetic]",
    sz.glyph,
  );
  return (
    <span
      ref={ref}
      title={title}
      // Marks the box as an avatar for a container that sizes a track to it
      // (a control panel's icon column, `cp-panel` in ui-kit's app.css).
      data-avatar=""
      style={custom ? ({ "--avatar-fill": fill } as CSSProperties) : undefined}
      // eslint-disable-next-line layout/no-adhoc-layout -- rigid inline-level avatar disc: inline-flex center on a shrink-0 leaf that sits inline in flex rows; Center is block-level grid and would break inline placement
      className={cn(
        // A size container, so the glyph's `cqh` share resolves against the box.
        "relative inline-flex shrink-0 items-center justify-center @container-[size]",
        SHAPE_CLASS[shape],
        sz.box,
        paint,
        className,
      )}
    >
      {drawn ? (
        <Icon icon={drawn} className={sz.icon} />
      ) : glyph ? (
        <span className={glyphClass}>{glyph}</span>
      ) : null}
      {statusDot ? (
        <span
          // eslint-disable-next-line layout/no-adhoc-layout -- status dot pinned bottom-right with a per-size overhang that is a share of the avatar box (SIZE_MAP), so it follows a themed box; not on the spacing ramp Pin/outset expresses
          className={cn(
            "absolute rounded-full ring-background",
            sz.dot,
            sz.ring,
            statusDot,
          )}
          aria-hidden
        />
      ) : null}
    </span>
  );
});
