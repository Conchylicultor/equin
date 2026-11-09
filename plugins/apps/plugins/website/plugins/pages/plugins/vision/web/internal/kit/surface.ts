import type { Colour } from "./palette";

/**
 * A frame's layer drawn on a canvas instead of as SVG nodes: for a drawing
 * whose many marks all move every frame (the globe's lights, people and arcs),
 * one canvas repainted is a fraction of the cost of re-posing a node per mark —
 * each attribute written is a style recalc of its element, a canvas draw is
 * none.
 *
 * The canvas covers the stage in screen pixels (device pixels behind them), and
 * the zoom engine places it as it places the frame's SVG layer — the same
 * translate and scale, the same opacity — so the drawing stays crisp at every
 * zoom (a canvas inside the scaled frame would be magnified up to 5×). Its
 * stacking order is the layer's own: a z-index equal to the frame layer's,
 * after it in the stage, so it paints right over that layer and under the next.
 */
export interface Surface {
  /**
   * The context, cleared and set to the frame's units (1000 × 1000 centred on
   * (0, 0)) for one paint; null while the layer is hidden (nothing to draw).
   */
  begin(): CanvasRenderingContext2D | null;
  /** A palette colour as the canvas takes it (the `--vz-…` value it names). */
  colour(c: Colour): string;
}

/** The zoom engine's handle on a surface: where the frame sits and how visible it is. */
export interface SurfaceHost extends Surface {
  /** The stage's size changed. */
  resize(width: number, height: number): void;
  /** Frame units → stage px: the frame's centre at (x, y), `scale` stage px per unit. */
  place(x: number, y: number, scale: number): void;
  /** The frame layer's opacity and visibility, mirrored. */
  show(opacity: string, visible: boolean): void;
}

export function mountSurface(stage: HTMLElement, z: number): SurfaceHost {
  const canvas = document.createElement("canvas");
  canvas.className = "z-surface";
  canvas.style.zIndex = String(z);
  canvas.style.visibility = "hidden";
  stage.appendChild(canvas);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("[vision] no 2d context for a surface");
  const style = getComputedStyle(stage);
  const colours = new Map<Colour, string>();
  let dpr = 1;
  let at = { x: 0, y: 0, scale: 1 };
  let visible = false;
  return {
    begin() {
      if (!visible) return null;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const s = at.scale * dpr;
      ctx.setTransform(s, 0, 0, s, at.x * dpr, at.y * dpr);
      return ctx;
    },
    colour(c) {
      let v = colours.get(c);
      if (v === undefined) {
        const name = /^var\((--[\w-]+)\)$/.exec(c)?.[1];
        v = name ? style.getPropertyValue(name).trim() : "";
        if (!v) throw new Error(`[vision] no value for colour ${c}`);
        colours.set(c, v);
      }
      return v;
    },
    resize(width, height) {
      dpr = window.devicePixelRatio || 1;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
    },
    place(x, y, scale) {
      at = { x, y, scale };
    },
    show(opacity, on) {
      visible = on;
      if (canvas.style.opacity !== opacity) canvas.style.opacity = opacity;
      const vis = on ? "visible" : "hidden";
      if (canvas.style.visibility !== vis) canvas.style.visibility = vis;
    },
  };
}
