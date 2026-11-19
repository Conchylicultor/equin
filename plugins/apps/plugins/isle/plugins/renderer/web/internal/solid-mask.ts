// What of a painted canvas hides a person standing behind it: its alpha, the
// near-transparent parts (a cast shadow, washes) cut away. A person behind a
// tree, a rock or a building is drawn into its own layer and cut there by the
// solid part of whatever stands in front (`engine.ts`'s figures).
//
// Reading a canvas's pixels on the page is a GPU readback where the browser
// draws canvases on the GPU — a round trip per canvas, on the page's thread.
// The first frame a crowd walks (the title card's Start) used to read every
// cut-out it needed at once: 687 ms of script in one frame on a visitor's
// Windows laptop (report-1795102621-0vg2pk). So a bake worker reads them
// (`bake.worker.ts`, as it reads the buildings' hit masks), and until a
// cut-out is in, the whole painting cuts: for a frame or two a person behind
// a tree is also hidden by its shadow, never a stall.

import type { BakePool } from "./bake-pool";
import { canvas, ctx2d } from "./kit";

/** Cuts a person out by a painted canvas: the image to `destination-out` with. */
export type Cutter = (c: HTMLCanvasElement) => CanvasImageSource;

const SOLID_A = 100;

/** The solid part of RGBA bytes, in place: every pixel under SOLID_A alpha cleared. Pure, so the worker's is the page's. */
export function solidInPlace(d: Uint8ClampedArray): void {
  for (let i = 3; i < d.length; i += 4) if (d[i]! < SOLID_A) d[i] = 0;
}

/** The cut-out read on the page: where there is no worker to read it. */
function solidOnPage(c: HTMLCanvasElement): HTMLCanvasElement {
  const m = canvas(c.width, c.height);
  const mg = ctx2d(m, { willReadFrequently: true });
  mg.drawImage(c, 0, 0);
  const im = mg.getImageData(0, 0, m.width, m.height);
  solidInPlace(im.data);
  mg.putImageData(im, 0, 0);
  return m;
}

/** Every painted canvas's cut-out, read once each — in a bake worker when there is one. */
export class SolidMasks {
  private readonly done = new WeakMap<HTMLCanvasElement, CanvasImageSource>();
  private readonly asked = new WeakSet<HTMLCanvasElement>();

  constructor(
    private readonly pool: BakePool | null,
    private readonly onError: (err: Error) => void,
  ) {}

  /** `c`'s cut-out; `c` itself while a worker is still reading it. */
  readonly of: Cutter = (c) => {
    const hit = this.done.get(c);
    if (hit) return hit;
    const pool = this.pool;
    if (!pool?.working) {
      const m = solidOnPage(c);
      this.done.set(c, m);
      return m;
    }
    if (!this.asked.has(c)) {
      this.asked.add(c);
      createImageBitmap(c)
        .then((bmp) => pool.solid(bmp))
        .then((m) => {
          this.done.set(c, m === "failed" ? solidOnPage(c) : m);
        })
        .catch((err: unknown) =>
          this.onError(err instanceof Error ? err : new Error(String(err))),
        );
    }
    return c;
  };
}
