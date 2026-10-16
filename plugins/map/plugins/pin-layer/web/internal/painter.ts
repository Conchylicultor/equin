import { MAP_LABEL_HALO_PX } from "@plugins/map/web";

/** One text the layer draws: beside a mark (haloed map-label paint) or in its middle. */
export type PaintText =
  | {
      at: "beside";
      text: string;
      /** The line's left edge and vertical middle, container px. */
      x: number;
      y: number;
      ink: string;
      halo: string;
    }
  | {
      at: "center";
      text: string;
      /** The line's centre, container px. */
      x: number;
      y: number;
      color: string;
    };

/**
 * How a pin layer puts pixels on its surface — the ONE seam a drawing backend
 * implements. Canvas 2D today; a WebGL painter (a map's own GL context, or
 * deck.gl) would implement the same three calls.
 */
export interface PinPainter {
  /** Start a frame of `width` × `height` CSS px at `dpr`: size the surface, clear it. */
  begin(width: number, height: number, dpr: number): void;
  /** A sprite with its box's top-left at `(x, y)` CSS px, drawn at `w` × `h`. */
  sprite(bitmap: ImageBitmap, x: number, y: number, w: number, h: number): void;
  text(t: PaintText, fonts: { label: string; count: string }): void;
}

/** Longest a text beside a mark runs before it is cut with an ellipsis (`MapLabel`'s `max-w-48`). */
const MAX_BESIDE_PX = 192;

export function createCanvas2dPainter(canvas: HTMLCanvasElement): PinPainter {
  const ctx = canvas.getContext("2d");
  if (ctx === null) throw new Error("pin layer: the canvas has no 2d context");
  return {
    begin(width, height, dpr) {
      const w = Math.round(width * dpr);
      const h = Math.round(height * dpr);
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
    },
    sprite(bitmap, x, y, w, h) {
      ctx.drawImage(bitmap, x, y, w, h);
    },
    text(t, fonts) {
      if (t.at === "center") {
        ctx.font = fonts.count;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillStyle = t.color;
        ctx.fillText(t.text, t.x, t.y);
        return;
      }
      ctx.font = fonts.label;
      ctx.textAlign = "left";
      ctx.textBaseline = "middle";
      const text = fit(ctx, t.text, MAX_BESIDE_PX);
      ctx.lineJoin = "round";
      ctx.lineWidth = MAP_LABEL_HALO_PX;
      ctx.strokeStyle = t.halo;
      ctx.strokeText(text, t.x, t.y);
      ctx.fillStyle = t.ink;
      ctx.fillText(text, t.x, t.y);
    },
  };
}

/** `text`, cut with an ellipsis to fit `maxPx` in the current font. */
function fit(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxPx: number,
): string {
  if (ctx.measureText(text).width <= maxPx) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (ctx.measureText(`${text.slice(0, mid)}…`).width <= maxPx) lo = mid;
    else hi = mid - 1;
  }
  return `${text.slice(0, lo)}…`;
}
