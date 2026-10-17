import type { CSSProperties } from "react";
import { Badge } from "@plugins/primitives/plugins/css/plugins/badge/web";
import { cn } from "@plugins/primitives/plugins/css/plugins/ui-kit/web";
import { colorCssValue } from "@plugins/page/plugins/editor/core";
import type { PageTagRow, TagColor } from "../../core";

/**
 * A tag hue as CSS: the page editor's `--rt-color-<token>` palette var — the
 * one palette text color, callouts and tags share, so a theme repaints all
 * three. A tag always has a hue (`TagColor` excludes `default`).
 */
export function tagHue(color: TagColor): string {
  // `colorCssValue` answers null only for `default`/absent, which `TagColor`
  // cannot be.
  return colorCssValue(color)!;
}

/**
 * The soft chip treatment: the hue as the text, over a tint of itself.
 * `color-mix` keeps the tint a function of the token, so a light and a dark
 * theme each get a wash of their own tone rather than one fixed alpha color.
 */
function softChipStyle(color: TagColor): CSSProperties {
  const hue = tagHue(color);
  return {
    color: hue,
    backgroundColor: `color-mix(in oklab, ${hue} 16%, transparent)`,
  };
}

/**
 * One tag as a chip: the soft treatment (tinted ground, colored words, the
 * chip's own small radius). Its size is the ambient control density's, like
 * every `Badge` — a reference row declares `xs` and gets the compact rung.
 */
export function TagChip({
  tag,
  className,
}: {
  tag: PageTagRow;
  className?: string;
}) {
  return (
    <Badge
      // The hue arrives as a style (a CSS var per tag), so the variant's own
      // color classes are replaced by none.
      colorClass=""
      style={softChipStyle(tag.color)}
      className={className}
      tooltip={tag.name}
    >
      {tag.name}
    </Badge>
  );
}

/** A tag's hue as a small round mark — the sidebar row marker, the picker's swatch. */
export function TagDot({
  color,
  className,
}: {
  color: TagColor;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={cn("inline-block size-2 rounded-full", className)}
      style={{ backgroundColor: tagHue(color) }}
    />
  );
}
