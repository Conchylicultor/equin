import type { IconBody } from "@plugins/ui/plugins/icons/server";

/**
 * How a Lucide glyph is tuned to sit beside the app's text, baked into the
 * `lucide` sprite so every use is identical:
 *
 * - the glyph fills 7/8 of its box (14px in a 16px slot), centred;
 * - its stroke renders at {@link LUCIDE_STROKE_PX} CSS px at any size
 *   (`vector-effect="non-scaling-stroke"`), where Lucide's own 2-unit stroke
 *   would grow and shrink with the icon.
 *
 * Bump {@link LUCIDE_TUNING_VERSION} when this changes: it is folded into the
 * sprite hash, so a cached sprite is never served with the old tuning.
 */
export const LUCIDE_TUNING_VERSION = "1: 7/8 box, 1.2px non-scaling stroke";

export const LUCIDE_SCALE = 0.875;
export const LUCIDE_STROKE_PX = 1.2;

/** Lucide's own stroke width, the one value a body may carry. */
const LUCIDE_STROKE_WIDTH = "2";

/** The elements a Lucide body is drawn with; anything else throws. */
const SHAPES = new Set([
  "path",
  "circle",
  "ellipse",
  "rect",
  "line",
  "polyline",
  "polygon",
]);

const TAG_RE = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g;
const STROKE_WIDTH_RE = /\sstroke-width="([^"]*)"/g;

function tuneTag(
  tag: string,
  closing: string,
  name: string,
  attrs: string,
  selfClosing: string,
): string {
  if (closing) {
    if (name !== "g")
      throw new Error(`[icons] unexpected </${name}> in a Lucide body`);
    return tag;
  }
  if (name !== "g" && !SHAPES.has(name)) {
    throw new Error(`[icons] unexpected <${name}> in a Lucide body`);
  }
  const tuned = attrs.replace(STROKE_WIDTH_RE, (_m, width: string) => {
    if (width !== LUCIDE_STROKE_WIDTH) {
      throw new Error(
        `[icons] a Lucide body has stroke-width="${width}", not Lucide's "${LUCIDE_STROKE_WIDTH}"`,
      );
    }
    return ` stroke-width="${LUCIDE_STROKE_PX}"`;
  });
  // Not inherited: every shape carries its own.
  const effect = SHAPES.has(name) ? ' vector-effect="non-scaling-stroke"' : "";
  return `<${name}${tuned}${effect}${selfClosing}>`;
}

/**
 * One Lucide icon's body, tuned (see {@link LUCIDE_TUNING_VERSION}). Its box is
 * unchanged; the glyph is scaled about the box's centre. An element or a
 * stroke width Lucide does not use throws: tuning it would be a guess.
 */
export function tuneLucideBody({ body, width, height }: IconBody): IconBody {
  const inner = body.replace(TAG_RE, tuneTag);
  const dx = (width * (1 - LUCIDE_SCALE)) / 2;
  const dy = (height * (1 - LUCIDE_SCALE)) / 2;
  return {
    body: `<g transform="translate(${dx} ${dy}) scale(${LUCIDE_SCALE})" stroke-width="${LUCIDE_STROKE_PX}">${inner}</g>`,
    width,
    height,
  };
}
